import { NextResponse } from 'next/server';
import { Client } from '@upstash/qstash';
import { createClient } from '@supabase/supabase-js';
import { Agent } from 'undici';

// The NIM call can run for many minutes — give the route handler headroom.
export const runtime = 'nodejs';
export const maxDuration = 60;

// Long-running LLM calls — Llama-3.1-70B with 8 topics and 8000 max_tokens
// regularly takes 6-10 minutes to return its first byte. Undici's default
// headersTimeout/bodyTimeout of 5 minutes was killing the request on Render
// with UND_ERR_HEADERS_TIMEOUT before NIM could respond. This dispatcher is
// scoped to the NVIDIA fetch only so Tavily / Supabase keep their snappy defaults.
const NVIDIA_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const nvidiaDispatcher = new Agent({
  headersTimeout: NVIDIA_TIMEOUT_MS,
  bodyTimeout:    NVIDIA_TIMEOUT_MS,
  connectTimeout: 30_000,
  keepAliveTimeout: 60_000,
});

// We allow 4 attempts total — initial + 3 retries with backoff (5s, 15s, 45s).
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

// Errors that mean "try again, the network or the upstream blinked" — NOT
// errors that mean "the request itself is bad and would keep failing".
const TRANSIENT_ERROR_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

function isTransientError(err: any): boolean {
  if (!err) return false;
  const code = err.code || err.cause?.code;
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
  if (err.name === 'AbortError') return true;
  return false;
}

const qstashClient = new Client({ token: process.env.QSTASH_TOKEN || '' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://fnregtunsnipacueuddw.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function markEpisodeStatus(
  episodeWeekId: string,
  patch: Record<string, any>,
) {
  // We stash status / error info on `analysis_json` so we don't need a schema
  // migration. The UI knows: script_text present ⇒ ready; analysis_json.error
  // ⇒ failed; analysis_json.status === 'generating' ⇒ in-flight.
  const { error } = await supabase
    .from('episodes')
    .upsert(
      {
        week_id: episodeWeekId,
        analysis_json: patch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'week_id' },
    );
  if (error) console.error('[Analyze] Failed to update episode status:', error);
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const isCallback = url.searchParams.get('isCallback') === 'true';

    // ─── CALLBACK: Receives AI response, saves to DB ──────────────────────────
    if (isCallback) {
      const episodeWeekId = url.searchParams.get('episodeId');
      const topicIdsParam  = url.searchParams.get('topicIds') || '';
      // 'text' for models that can't emit reliable JSON (e.g. Sarvam-M), 'json' otherwise.
      const responseFormat = url.searchParams.get('format') === 'text' ? 'text' : 'json';

      if (!episodeWeekId) {
        return NextResponse.json({ error: 'Missing episodeId in callback' }, { status: 400 });
      }

      const body = await req.json();

      if (!body.choices?.[0]?.message) {
        console.error('[Callback] Invalid AI response structure', JSON.stringify(body).slice(0, 500));
        return NextResponse.json({ error: 'Invalid AI response' }, { status: 500 });
      }

      let rawContent: string = body.choices[0].message.content;
      const finishReason: string | undefined = body.choices?.[0]?.finish_reason;
      const truncatedByModel = finishReason === 'length';

      // Strip reasoning prose. Reasoning models leak it as <think>...</think>,
      // sometimes with malformed / mismatched tags, sometimes as plain prose.
      //   1. Strip well-formed <think>...</think> pairs.
      //   2. If an orphan </think> remains, drop everything up to and including it.
      rawContent = rawContent
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^[\s\S]*?<\/think>\s*/i, '')
        .trim();
      // For JSON responses, also drop any prose that sits before the first '{'.
      if (responseFormat === 'json') {
        const firstBrace = rawContent.indexOf('{');
        if (firstBrace > 0) rawContent = rawContent.slice(firstBrace);
      }

      let scriptText = '';
      let analysisJson: any = null;
      let recoveryNote: string | null = null;

      if (responseFormat === 'text') {
        // Plain-text branch — Sarvam-M can't be trusted to emit valid JSON, so
        // the Tenglish trigger asks it for the script as bare text. We just
        // clean the prose and use it directly.
        scriptText = rawContent
          // Some models still wrap their output in ```...``` despite being told not to.
          .replace(/^```[a-z]*\n?/gi, '')
          .replace(/```\s*$/g, '')
          // Strip a leading "Script:" / "Output:" / "Here is the script:" label
          // if the model added one out of habit.
          .replace(/^\s*(here\s+is\s+(the\s+)?(spoken\s+)?(podcast\s+)?script\s*[:\-—]\s*|script\s*[:\-—]\s*|output\s*[:\-—]\s*)/i, '')
          // Strip "Okay, " / "Sure, " / "Let me " leaders just in case.
          .replace(/^(okay|alright|sure|let me|i need to)[^.\n]{0,200}\.\s+/i, '')
          .trim();
      } else {
        // JSON branch — Llama-family models follow {"script":"..."} reliably.
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        const jsonCandidate = jsonMatch ? jsonMatch[0] : rawContent;

        try {
          const parsed = JSON.parse(jsonCandidate);
          if (typeof parsed.script === 'string') {
            scriptText = parsed.script.trim();
          } else {
            const segments = parsed.segments ?? parsed.topics ?? parsed.items ?? (Array.isArray(parsed) ? parsed : []);
            scriptText = segments
              .map((item: any) => (item.spoken_script || item.script || '').trim())
              .filter(Boolean)
              .join('\n\n');
          }
        } catch {
          // JSON parse failed — usually because the response was truncated mid-string.
          // Try to recover the script value with a regex, unescaping JSON-style escapes.
          const scriptMatch = rawContent.match(/"script"\s*:\s*"([\s\S]*?)(?:"\s*\}\s*$|$)/);
          if (scriptMatch && scriptMatch[1].trim()) {
            scriptText = scriptMatch[1]
              .replace(/\\n/g, '\n')
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, '\\')
              .trim();
            recoveryNote = truncatedByModel
              ? 'Recovered partial script — model output was cut off by the token limit.'
              : 'Recovered partial script — response JSON was malformed.';
            console.warn(`[Callback] ${recoveryNote}`);
          } else {
            // Nothing usable. Mark the episode as failed instead of saving reasoning prose as the script.
            const errMsg = `Could not parse script from NIM response (finish_reason=${finishReason || 'unknown'}). First 300 chars: ${rawContent.slice(0, 300)}`;
            console.error('[Callback] Failed to parse and could not recover script:', errMsg);
            await supabase
              .from('episodes')
              .upsert(
                {
                  week_id: episodeWeekId,
                  analysis_json: {
                    status: 'failed',
                    error: errMsg.slice(0, 500),
                    finish_reason: finishReason,
                    failed_at: new Date().toISOString(),
                  },
                  updated_at: new Date().toISOString(),
                },
                { onConflict: 'week_id' },
              );
            return NextResponse.json({ error: 'Failed to parse script from model output.' }, { status: 502 });
          }
        }
      }

      if (!scriptText) {
        const errMsg = `Model returned an empty script (finish_reason=${finishReason || 'unknown'}).`;
        console.error('[Callback]', errMsg);
        await supabase
          .from('episodes')
          .upsert(
            {
              week_id: episodeWeekId,
              analysis_json: { status: 'failed', error: errMsg, finish_reason: finishReason, failed_at: new Date().toISOString() },
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'week_id' },
          );
        return NextResponse.json({ error: errMsg }, { status: 502 });
      }

      // Belt-and-braces: strip any markdown / stray reasoning leaders that snuck through.
      scriptText = scriptText
        .replace(/```[a-z]*\n?/gi, '')
        .replace(/```/g, '')
        .replace(/^#+\s+/gm, '')
        .replace(/^(okay|alright|sure|let me|i need to)[^.\n]{0,200}\.\s+/i, '')
        .trim();

      analysisJson = recoveryNote
        ? { script: scriptText, recovery_note: recoveryNote, finish_reason: finishReason }
        : { script: scriptText };

      // Upsert episode by week_id, get back the UUID
      const { data: episodeRow, error: upsertError } = await supabase
        .from('episodes')
        .upsert(
          { week_id: episodeWeekId, analysis_json: analysisJson, script_text: scriptText, updated_at: new Date().toISOString() },
          { onConflict: 'week_id' }
        )
        .select('id')
        .single();

      if (upsertError) {
        console.error('[Callback] Supabase upsert error:', upsertError);
        throw upsertError;
      }

      // Link the source updates to this episode
      const topicIds = topicIdsParam ? topicIdsParam.split(',').filter(Boolean) : [];
      if (topicIds.length && episodeRow?.id) {
        const { error: linkErr } = await supabase
          .from('updates')
          .update({ episode_id: episodeRow.id, status: 'done' })
          .in('id', topicIds);
        if (linkErr) console.error('[Callback] Failed to link updates:', linkErr);
      }

      return NextResponse.json({ success: true, message: 'Analysis complete.', recoveryNote });

    // ─── TRIGGER: Frontend calls this to kick off AI analysis ─────────────────
    } else {
      const body = await req.json();
      const { episodeId, topics, language: rawLanguage } = body;

      if (!episodeId || !topics?.length) {
        return NextResponse.json({ error: 'Missing episodeId or topics' }, { status: 400 });
      }

      const language: 'english' | 'tenglish' = rawLanguage === 'tenglish' ? 'tenglish' : 'english';
      const nvidiaApiKey = process.env.NVIDIA_API_KEY || '';

      // Both languages now run on Llama-3.1-70B-Instruct on NVIDIA NIM.
      // Sarvam-M (Indic-focused) was tried for Tenglish but couldn't handle
      // 8-topic long-form scripts — it bundled topics, terminated early
      // (~2-3k tokens), and couldn't emit reliable JSON. Llama-70B follows
      // structured output, holds an 8-topic plan in context, and produces
      // serviceable code-mixed Romanized Telugu with the system prompt below.
      const modelId = 'meta/llama-3.1-70b-instruct';

      const englishSystemPrompt = `You are Teja, the host of TechX TV. You write ONE flowing podcast script — not segments, not bullets, not titles. The script must hold a listener for the full runtime using real audio-retention craft.

═══ THE COLD OPEN — first 30 seconds decide everything ═══
Before the brand greeting, lead with ONE punchy cold-hook line pulled from the day's biggest / most surprising story: a shocking stat, a polarizing claim, a specific number, or a cliffhanger. Then transition into the brand welcome. NEVER open with housekeeping or "today we'll talk about a few things."

BAD: "Hey, welcome back, today we'll talk about AI agents and some new tools."
GOOD: "An autonomous AI agent just burned five thousand dollars of its creator's money without permission. Hey, welcome back to TechX TV. I'm Teja, and today we have [N] stories — that one's coming up. Let's get into it."

═══ DOPAMINE — anticipation, not reward ═══
Dopamine fires on the EXPECTATION of a payoff, not the payoff itself. Engineer that expectation:
- CURIOSITY GAPS: never give a story's conclusion at the top of the story. Open with the question or the strange surface, deliver the answer at the end.
- OPEN LOOPS across stories. Before you finish story A, plant a one-line tease for a later story. "We'll come back to why Google is panicking in about three minutes — but first…" CLOSE every loop you open.
- VARIABLE REWARDS / VARIABLE PACING. Don't give every story equal weight. Mix two rapid-fire 20-second hits with a slow 2-3 minute deep dive, then a one-liner. Predictable pacing = brain checks out.

═══ PICK THE RIGHT FRAMEWORK PER STORY ═══
Match the structure to the news type — don't run every story the same way.

[A] TOOLS / SOFTWARE UPDATES → "What → So What → Now What"
   What: the raw news.
   So What: what it disrupts. Whose workflow just became outdated.
   Now What: an actionable takeaway — a prompt to try, a habit to change tomorrow morning, a thing to install.

[B] AI BREAKTHROUGHS / RESEARCH → ABT (And, But, Therefore)
   "And …" status quo. "But …" the conflict that breaks it. "Therefore …" the stakes.
   Example shape: "AI agents are getting smarter AND billions are flowing in. BUT a single text message can now hijack one. THEREFORE every enterprise rollout has stalled this week."

[C] BIG TECH BATTLES / FUNDING / MARKET DRAMA → David vs Goliath
   Cast companies as characters. The giant ruling the space. The underdog or surprise event threatening it. The current moment of tension. People don't care about corporations — they care about rivalries and blunders.

═══ EMOTIONAL FRAMING — choose the core emotion ═══
- AI news / breakthroughs → AWE + EXISTENTIAL CURIOSITY. Frame as a "Point of No Return" — yesterday vs tomorrow.
- New tools → GREED + FOMO. Frame as a "Secret Advantage" — insider info their peers don't have yet.
- Tech drama / business → VOYEURISM + ENTERTAINMENT. Frame as a "High-Stakes Chess Match" — ego, rivalry, brilliant blunders.

═══ RHYTHM AND THE MICRO-RESET (every ~90-120 seconds) ═══
Audio has no visuals — boredom is the enemy. Reset the brain often:
- Vary sentence length aggressively. A long, winding setup. Then a short jab. Then a question. Then a fact.
- Use rhetorical questions to wake them up: "Why now? Simple."
- Hard pivot cues: "Here's the part nobody is talking about.", "Okay, but here's where it gets weird.", "Pause for a second — think about what that actually means."
- Between stories, use a varied one-line bridge — NEVER reuse the same bridge twice. Bridges should NOT read like headlines. "Now there's this thing called Higgsfield that…" — not "Next up, Higgsfield Supercomputer."

═══ VOICE ═══
The smart friend who happens to know tech. Conversational, direct, grounded in real consequences (jobs, money, power, daily life). NEVER hyped — no "this is incredible," no fake excitement. Depth of Acquired, directness of Recode, warmth of How I Built This.

═══ ABSOLUTE RULES ═══
- ONE continuous flowing script. NO titles, NO "Topic one", NO segment labels, NO importance markers, NO bullets, NO markdown, NO headers, NO quoted topic titles.
- Cover EVERY topic in the input. Don't skip, don't merge.
- ORDER THE TOPICS YOURSELF. Input order is a list, not a sequence — you decide the running order that makes the best podcast. Lead with the strongest story (biggest, most surprising, most consequential). Group thematically related stories so transitions are natural. Save a memorable beat for near the end. Vary energy: don't put two slow analytical pieces back to back.
- Connect related stories IN-LINE: "This is the same pressure we just hit with X — both companies are reacting to…"
- Banned lazy phrases: "in conclusion", "to summarize", "it remains to be seen", "at the end of the day". Just say the thing.
- Every sentence earns its place.
- NO <think> tags, NO reasoning aloud, NO prose outside the JSON.

═══ FIXED STRUCTURAL ANCHORS ═══
OPENING shape (in this order):
  1) ONE-LINE cold-hook from the day's biggest story.
  2) "Hey, welcome back to TechX TV. I'm Teja, and today we have [exact number] stories. Let's get into it."

CLOSING (final words, verbatim): "That's everything for today's episode. If something here made you think, share it with someone who'd care. See you next time."

═══ LENGTH IS DRIVEN BY THE STORY ═══
No word count, no length quota. A topic gets exactly as much room as it earns:
- A small product update or a one-line scoop? Two strong sentences and move on.
- A genuinely big shift (a model release, a billion-dollar deal, a research breakthrough)? Give it the paragraph or two it needs to land — the catalyst, the stakes, the consequence.
- Never pad to fill time. Never repeat the same point twice in different words. If you're tempted to write a transition sentence with no information in it, cut it.
The script ends when every topic has been covered as well as it deserves and the closing line lands. That length is correct — whatever it is.

═══ OUTPUT FORMAT — return ONLY this JSON, nothing else ═══
Your ENTIRE response MUST start with the character "{" and end with the character "}". Do NOT precede the JSON with any text — no greeting, no plan, no "Okay,", no "Sure,", no "Let me think", no "<think>" block, no markdown fence. The first character of your output is "{". If you need to plan, do it silently. Anything outside the JSON breaks the pipeline.
{
  "script": "[cold-hook line] Hey, welcome back to TechX TV. I'm Teja, and today we have [N] stories. Let's get into it. … [one flowing script with open loops, framework-shaped stories, micro-resets, variable pacing] … That's everything for today's episode. If something here made you think, share it with someone who'd care. See you next time."
}`;

      const tenglishSystemPrompt = `You are Teja, the host of TechX TV. Telugu audience kosam Tenglish lo matladu — Romanized Telugu + English tech words mixed naturally, exactly how Telugu people actually talk. NOT formal Telugu, NOT pure translation. Your output is ONE flowing podcast script — no segments, no bullets, no titles.

═══ LANGUAGE RULES ═══
- Romanized Telugu only (Latin script). Use "manam", "chuddam", "ante", "kani", "ippudu" — NOT "మనం", "చూద్దాం". NO Telugu script characters anywhere.
- Tech terms, product names, company names, numbers, units stay in ENGLISH: GPU, model, chip, AI, startup, billion, parameters, latency, benchmark, agent, prompt.
- Connectors, verbs, pronouns, fillers stay in Telugu: "ante", "kabatti", "ippudu", "asalu", "manaki", "valla", "endukante", "matter ento ante".
- Real Tenglish = both in every sentence. NO pure-Telugu and NO pure-English sentences.

═══ THE COLD OPEN — first 30 seconds decide everything ═══
Brand greeting ki mundu, ONE punchy cold-hook line vaadu — day's biggest / most surprising story nundi: shocking stat, polarizing claim, specific number, or cliffhanger. Tarvaata brand welcome lo transition avvu. Housekeeping tho ela start avvaku.

BAD: "Hey, welcome back, ee roju konni updates chuddam…"
GOOD: "Oka autonomous AI agent intaki creator permission lekunda five thousand dollars burn chesindi. Hey, welcome back to TechX TV. Nenu Teja, ee roju manaki [N] stories unnayi — aa story kuda vastundi. Let's get into it."

═══ DOPAMINE — anticipation, not reward ═══
Dopamine reward miss avvadu, payoff EXPECTATION lo release avtundi. Aa expectation engineer cheyyi:
- CURIOSITY GAPS: story start lo conclusion ivvaku. Question or strange surface tho start cheyyi, answer end lo deliver cheyyi.
- OPEN LOOPS across stories. Story A finish avvaka mundu, later story ki tease pettu: "Endhuku Google panic avtundi ante — aa point ki manam mundu-mundu vasthaam, kaani ippudu…" Loop open cheste close kuda chala important.
- VARIABLE REWARDS / VARIABLE PACING. Anni stories ki same weight ivvaku. Rendu rapid-fire 20-second hits, taruvaata slow 2-3 minute deep dive, taruvaata one-liner. Same pacing = brain check-out.

═══ PICK THE RIGHT FRAMEWORK PER STORY ═══
News type ki match aindi structure vaadu — anni stories ni same shape lo cheppaku.

[A] TOOLS / SOFTWARE UPDATES → "What → So What → Now What"
   What: raw news.
   So What: idi enni workflows ni outdated cheste? Evari pani disturbance avtundi?
   Now What: actionable takeaway — rEpu morning try cheyyali ane prompt, install cheyyali ane tool, maaralsina habit.

[B] AI BREAKTHROUGHS / RESEARCH → ABT (And, But, Therefore)
   "And…" status quo. "But…" conflict that breaks it. "Therefore…" stakes.
   Example shape: "AI agents smart avtunnayi AND billions flow avtunnayi. BUT oka single text message tho agent ni hijack cheyyochu. THEREFORE ee week enterprise rollouts annee stall ayipoyayi."

[C] BIG TECH BATTLES / FUNDING / MARKET DRAMA → David vs Goliath
   Companies ni characters laaga cast cheyyi. Space lo unna giant, threat chestunna underdog or surprise event, present tension. Asalu corporations ni evvaru pattinchukoru — characters, rivalries, blunders ni pattinchukuntaaru.

═══ EMOTIONAL FRAMING — story core emotion choose cheyyi ═══
- AI news / breakthroughs → AWE + EXISTENTIAL CURIOSITY. "Point of No Return" laaga frame cheyyi — ninna ela undedi, repu ela undabotunundo.
- New tools → GREED + FOMO. "Secret Advantage" laaga frame cheyyi — peers ki ledu kaani listener ki insider info.
- Tech drama / business → VOYEURISM + ENTERTAINMENT. "High-Stakes Chess Match" laaga frame cheyyi — ego, rivalry, brilliant blunders.

═══ RHYTHM AND THE MICRO-RESET (every ~90-120 seconds) ═══
Audio lo visuals levu — boredom enemy. Brain ni regular ga reset cheyyi:
- Sentence length aggressively vary cheyyi. Oka long winding setup. Taruvaata short jab. Taruvaata question. Taruvaata fact.
- Rhetorical questions vaadu: "Endhuku ippudu? Simple."
- Hard pivot cues: "Idi vinandi, asalu evaru cheppatledu.", "Sare, ippudu interesting twist undi.", "Oka second aagi alochinchandi — daani actual meaning enti?"
- Stories madhya varied one-line bridge — same bridge twice repeat avvaddu. Bridges headline laaga undavaddu. "Ippudu inko thing undi, daani peru Higgsfield ani…" — kaadu "Next up, Higgsfield Supercomputer."

═══ VOICE ═══
Real Telugu friend — smart, direct, casual but not lazy. Tea shop lo friends ki tech explain chestunnattu. NO hype, NO filler, NO fake excitement. Facts + impact + move on.

═══ ABSOLUTE RULES ═══
- ONE continuous flowing script. NO titles, NO "Topic one", NO segment labels, NO importance markers, NO bullets, NO markdown, NO headers, NO quoted topic titles.
- EVERY topic cover cheyyi — skip cheyyaku, merge cheyyaku.
- ORDER NEEVE DECIDE CHEYYI. Input order kevalam list, sequence kaadu. Best podcast flow ki tagattu nuvve order set cheyyi — biggest / most surprising story ni mundu pettu, related stories ni thematic group cheyyi, oka memorable beat ni end ki daggariga vunchu, slow analytical stories ni back-to-back pettaku.
- Related stories IN-LINE connect cheyyi: "Idi manam intaka matladina X tho same pressure — rendu companies kuda same direction lo react avtunnayi."
- Banned lazy phrases: "in conclusion", "to summarize", "it remains to be seen", "మొత్తానికి", "anyways". Just say the thing.
- Every sentence earn its place.
- NO <think> tags, NO reasoning aloud, NO prose before or after the spoken script.

═══ FIXED STRUCTURAL ANCHORS ═══
OPENING shape (in this order):
  1) ONE-LINE Tenglish cold-hook from the day's biggest story.
  2) "Hey, welcome back to TechX TV. Nenu Teja, ee roju manaki [exact number] stories unnayi. Let's get into it."

CLOSING (final words, verbatim): "Ade ee episode ki. Edaina interesting ga anipiste, share it with someone who'd care. See you next time."

═══ LENGTH IS DRIVEN BY THE STORY ═══
No word count, no length quota. A topic gets exactly as much room as it earns:
- A small product update or a one-line scoop? Two strong sentences and move on.
- A genuinely big shift (a model release, a billion-dollar deal, a research breakthrough)? Give it the paragraph or two it needs to land — the catalyst, the stakes, the consequence.
- Never pad to fill time. Never repeat the same point twice in different words. If you're tempted to write a transition sentence with no information in it, cut it.
The script ends when every topic has been covered as well as it deserves and the closing line lands. That length is correct — whatever it is.

═══ OUTPUT FORMAT — return ONLY this JSON, nothing else ═══
Your ENTIRE response MUST start with the character "{" and end with the character "}". DO NOT precede the JSON with any text — no greeting, no plan, no "Okay,", no "Sure,", no "Let me think", no English reasoning sentences, no "<think>" tags, no markdown fence. The first character of your output is "{". Silently plan inside your head, then write only the JSON. Anything outside the JSON breaks the pipeline.
{
  "script": "[Tenglish cold-hook line] Hey, welcome back to TechX TV. Nenu Teja, ee roju manaki [N] stories unnayi. Let's get into it. … [one flowing Tenglish script — cover EVERY topic with its own sustained beat, with open loops, framework-shaped stories, micro-resets, variable pacing] … Ade ee episode ki. Edaina interesting ga anipiste, share it with someone who'd care. See you next time."
}`;

      const systemPrompt = language === 'tenglish' ? tenglishSystemPrompt : englishSystemPrompt;

      // Each topic should arrive with a structured analysis_json (from /api/analytics, possibly
      // user-edited on the /analytics page). We feed the analysis as primary signal; raw content
      // stays as fallback context.
      const safeTopics = topics.map((t: any, i: number) => ({
        index:    i + 1,
        title:    t.title,
        source:   t.source || 'Unknown',
        analysis: t.analysis_json || t.analysis || null,
        content:  t.content ? String(t.content).substring(0, 1500) : '',
      }));

      const languageInstruction = language === 'tenglish'
        ? `Language: TENGLISH — naturally spoken Romanized Telugu with English tech words mixed in. NO Telugu script (no తెలుగు characters), only Latin letters. Every sentence must mix both — Telugu connectors/verbs/pronouns with English tech terms.`
        : `Language: ENGLISH — plain English, no other language.`;

      const renderTopicBlock = (t: any) => {
        const a = t.analysis;
        if (a && (a.summary || a.whyNow || a.biggerPicture)) {
          const facts = Array.isArray(a.keyFacts) && a.keyFacts.length
            ? a.keyFacts.map((f: string) => `  • ${f}`).join('\n')
            : '  (none)';
          return [
            `--- Topic ${t.index}: ${t.title} (Source: ${t.source}) ---`,
            `SUMMARY:        ${a.summary || '(missing)'}`,
            `WHY NOW:        ${a.whyNow || '(missing)'}`,
            `KEY FACTS:\n${facts}`,
            `BIGGER PICTURE: ${a.biggerPicture || '(missing)'}`,
            `HONEST TAKE:    ${a.honestTake || '(missing)'}`,
          ].join('\n');
        }
        // Fallback: no analysis available, just hand over raw content.
        return `--- Topic ${t.index}: ${t.title} (Source: ${t.source}) ---\n${t.content || 'No content provided.'}`;
      };

      const userPrompt = `Generate today's TechX TV episode as ONE single flowing spoken script.

${languageInstruction}

TOTAL TOPICS: ${safeTopics.length}. Cover every topic inside one continuous monologue. The numbering below is just a list, NOT a running order — you choose the order that makes the best podcast. No titles, no "Topic one", no labels, no bullets — just one host talking.

The topic briefs below are PRE-ANALYZED — each one already has a SUMMARY, WHY NOW (catalyst), KEY FACTS, BIGGER PICTURE, and an HONEST TAKE. Use those as your authoritative source of truth. Do NOT re-state them mechanically — translate them into spoken narrative with the dopamine / framework / micro-reset techniques from your system prompt.

BEFORE YOU WRITE, think silently about the editorial shape (do NOT output your plan):
- Which story is the strongest opener — the one whose hook lands the cold open?
- What's the best running order? Group what belongs together, vary energy, leave a memorable beat for late.
- Which stories are big enough to deserve sustained time, and which can be quick hits?
- Are there real cross-topic connections (same company, competing tech, shared trend)? Weave those in-line — don't force connections that aren't there.
- For each story, pick the framework only if it genuinely fits. The frameworks from your system prompt are tools, not a checklist. A story that doesn't fit any of them just gets told plainly and well.

THEN WRITE THE SCRIPT. Use varied bridges between stories. Don't echo topic titles verbatim as headlines. Don't force structure where it isn't needed.

Pre-analyzed topic briefs:
${safeTopics.map(renderTopicBlock).join('\n\n')}

Length and order both follow the story. You decide the running order — pick the lead, group what belongs together, save a memorable beat for late, don't stack slow stories. A small update gets two sharp sentences and a pivot; a major shift gets a paragraph or two with catalyst, stakes, and consequence. No padding. No filler transitions. The cold open and closing line are fixed; everything in between is yours to shape.

Return ONLY {"script": "..."} — a single JSON object with one "script" string. No segments array, no titles, no other keys, no prose outside the JSON, no <think> tags, no markdown inside the script.`;

      const topicIds = topics.map((t: any) => t.id).filter(Boolean).join(',');

      // Both branches run Llama-3.1-70B which follows JSON cleanly, so we
      // always ask for {"script": "..."} and parse it the same way.
      const callbackFormat: 'json' | 'text' = 'json';
      const nvidiaPayload: Record<string, any> = {
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        temperature: 0.75,
        max_tokens: 8000,
        response_format: { type: 'json_object' },
      };

      const host = req.headers.get('host') || 'localhost:3000';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const callbackUrl = `${protocol}://${host}/api/analyze?isCallback=true&episodeId=${episodeId}&topicIds=${topicIds}&format=${callbackFormat}`;

      // Deployment branching:
      //   • Vercel / serverless with short timeouts → set QSTASH_TOKEN to queue NVIDIA call.
      //   • Render / Fly / any long-running Node (or local) → run inline fire-and-forget. Same
      //     Node process handles the self-callback, so we hit 127.0.0.1 on the bound port.
      //
      // QStash is a public cloud queue — it can't deliver callbacks to localhost
      // or private IPs. If the request came in on a loopback / private host, we
      // ignore the token and use the inline branch even when QSTASH_TOKEN is set,
      // so a stray local env var can't break the dev flow.
      const isPrivateHost = /^(localhost|127\.|10\.|192\.168\.|::1)/i.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
      const useQStash = !!process.env.QSTASH_TOKEN && !isPrivateHost;
      if (process.env.QSTASH_TOKEN && isPrivateHost) {
        console.log(`[Analyze] QSTASH_TOKEN set but host "${host}" is local — falling back to inline branch.`);
      }

      if (!useQStash) {
        const port = process.env.PORT || '3000';
        const selfCallbackUrl = `http://127.0.0.1:${port}/api/analyze?isCallback=true&episodeId=${episodeId}&topicIds=${topicIds}&format=${callbackFormat}`;

        // Record that this episode is in-flight before we kick off the long NIM
        // call. If the user navigates away (or the call fails), the UI can read
        // this status and offer a Retry button.
        await markEpisodeStatus(episodeId, {
          status: 'generating',
          model: modelId,
          language,
          topic_count: safeTopics.length,
          topic_ids: topicIds ? topicIds.split(',') : [],
          started_at: new Date().toISOString(),
        });

        const runWithRetries = async (): Promise<void> => {
          let lastError: any = null;

          for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            // Watchdog: if the request runs longer than our dispatcher timeout
            // we abort it cleanly so the retry loop kicks in instead of leaking
            // a stuck connection.
            const ac = new AbortController();
            const watchdog = setTimeout(() => ac.abort(), NVIDIA_TIMEOUT_MS);

            try {
              console.log(
                `[Analyze] Calling NIM (${modelId}, ${language}) with ${safeTopics.length} topics ` +
                `(attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1})...`
              );

              const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${nvidiaApiKey}`,
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                },
                body: JSON.stringify(nvidiaPayload),
                signal: ac.signal,
                // @ts-expect-error — undici dispatcher option, not in stock fetch types
                dispatcher: nvidiaDispatcher,
              });

              const data = await res.json();

              // Retry on documented rate-limit or generic upstream 5xx errors.
              const upstreamRateLimited = res.status === 429 || data.error?.code === 429;
              const upstreamServerError = res.status >= 500 && res.status < 600;

              if ((upstreamRateLimited || upstreamServerError) && attempt < RETRY_DELAYS_MS.length) {
                const wait = RETRY_DELAYS_MS[attempt];
                console.log(`[Analyze] NIM responded ${res.status} (${upstreamRateLimited ? 'rate-limited' : 'server error'}), retrying in ${wait / 1000}s...`);
                lastError = new Error(`NIM HTTP ${res.status}`);
                await new Promise(r => setTimeout(r, wait));
                continue;
              }

              if (!res.ok || data.error) {
                throw new Error(
                  `NIM HTTP ${res.status}: ${data.error?.message || JSON.stringify(data).slice(0, 300)}`
                );
              }

              console.log('[Analyze] NVIDIA succeeded, firing self-callback...');
              fetch(selfCallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
              }).catch(err => console.error('[Analyze] Self-callback error:', err));
              return;
            } catch (err: any) {
              lastError = err;
              const transient = isTransientError(err);
              const willRetry = transient && attempt < RETRY_DELAYS_MS.length;
              console.error(
                `[Analyze] NVIDIA fetch failed (attempt ${attempt + 1}, transient=${transient}):`,
                err?.code || err?.name, err?.message,
              );
              if (!willRetry) break;
              const wait = RETRY_DELAYS_MS[attempt];
              console.log(`[Analyze] Retrying in ${wait / 1000}s...`);
              await new Promise(r => setTimeout(r, wait));
            } finally {
              clearTimeout(watchdog);
            }
          }

          // All retries exhausted — persist the failure so the UI can show it.
          const message = lastError?.message || String(lastError) || 'Unknown error';
          await markEpisodeStatus(episodeId, {
            status: 'failed',
            error: message.slice(0, 500),
            model: modelId,
            language,
            topic_count: safeTopics.length,
            topic_ids: topicIds ? topicIds.split(',') : [],
            failed_at: new Date().toISOString(),
          });
        };

        runWithRetries();
        return NextResponse.json({ success: true, status: 'Analysis running in background.' });

      } else {
        // QStash branch — used when running on serverless platforms with short timeouts.
        const message = await qstashClient.publishJSON({
          url: 'https://integrate.api.nvidia.com/v1/chat/completions',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${nvidiaApiKey}`, 'Accept': 'application/json' },
          body: nvidiaPayload,
          callback: callbackUrl,
        });

        return NextResponse.json({ success: true, messageId: message.messageId, status: 'Queued via QStash.' });
      }
    }

  } catch (error: any) {
    console.error('[Analyze] Route error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
