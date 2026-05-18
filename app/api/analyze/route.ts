import { NextResponse } from 'next/server';
import { Client } from '@upstash/qstash';
import { createClient } from '@supabase/supabase-js';

const qstashClient = new Client({ token: process.env.QSTASH_TOKEN || '' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://fnregtunsnipacueuddw.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const isCallback = url.searchParams.get('isCallback') === 'true';

    // ─── CALLBACK: Receives AI response, saves to DB ──────────────────────────
    if (isCallback) {
      const episodeWeekId = url.searchParams.get('episodeId');
      const topicIdsParam  = url.searchParams.get('topicIds') || '';

      if (!episodeWeekId) {
        return NextResponse.json({ error: 'Missing episodeId in callback' }, { status: 400 });
      }

      const body = await req.json();

      if (!body.choices?.[0]?.message) {
        console.error('[Callback] Invalid AI response structure', JSON.stringify(body).slice(0, 500));
        return NextResponse.json({ error: 'Invalid AI response' }, { status: 500 });
      }

      let rawContent: string = body.choices[0].message.content;

      // Some Indic / reasoning models (e.g. sarvam-m) leak <think>...</think> chain-of-thought.
      // Strip it before any parsing so it never ends up in the script.
      rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      // Extract the JSON object if the model wrapped it in prose / code fences.
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      const jsonCandidate = jsonMatch ? jsonMatch[0] : rawContent;

      // We now ask for a single flowing script: {"script": "..."}.
      // Fall back to legacy {"segments":[...]} responses so old episodes still work.
      let scriptText = '';
      let analysisJson: any = null;
      try {
        const parsed = JSON.parse(jsonCandidate);
        if (typeof parsed.script === 'string') {
          scriptText = parsed.script.trim();
          analysisJson = { script: scriptText };
        } else {
          const segments = parsed.segments ?? parsed.topics ?? parsed.items ?? (Array.isArray(parsed) ? parsed : []);
          scriptText = segments
            .map((item: any) => (item.spoken_script || item.script || '').trim())
            .filter(Boolean)
            .join('\n\n');
          analysisJson = { script: scriptText };
        }
      } catch {
        console.error('[Callback] Failed to parse JSON. Raw:', rawContent.slice(0, 500));
        // Last resort: keep the raw content as the script body.
        scriptText = rawContent;
        analysisJson = { script: scriptText };
      }

      // Belt-and-braces: strip any markdown that snuck through.
      scriptText = scriptText
        .replace(/```[a-z]*\n?/gi, '')
        .replace(/```/g, '')
        .replace(/^#+\s+/gm, '')
        .trim();

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

      return NextResponse.json({ success: true, message: 'Analysis complete.' });

    // ─── TRIGGER: Frontend calls this to kick off AI analysis ─────────────────
    } else {
      const body = await req.json();
      const { episodeId, topics, language: rawLanguage } = body;

      if (!episodeId || !topics?.length) {
        return NextResponse.json({ error: 'Missing episodeId or topics' }, { status: 400 });
      }

      const language: 'english' | 'tenglish' = rawLanguage === 'tenglish' ? 'tenglish' : 'english';
      const nvidiaApiKey = process.env.NVIDIA_API_KEY || '';

      // Model + prompt branch by language.
      //   english  -> Llama-3.1-70B-Instruct  (high-reasoning English analysis)
      //   tenglish -> Sarvam-M (Indic LLM with native code-mixed Romanized Telugu support)
      // Both are hosted free on NVIDIA NIM (build.nvidia.com), so the API key, endpoint
      // and request shape are identical — only `model` and the system prompt differ.
      const modelId = language === 'tenglish' ? 'sarvamai/sarvam-m' : 'meta/llama-3.1-70b-instruct';

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
- Cover EVERY topic in the input, in the order given. Don't skip, don't merge.
- Connect related stories IN-LINE: "This is the same pressure we just hit with X — both companies are reacting to…"
- Banned lazy phrases: "in conclusion", "to summarize", "it remains to be seen", "at the end of the day". Just say the thing.
- Every sentence earns its place.
- NO <think> tags, NO reasoning aloud, NO prose outside the JSON.

═══ FIXED STRUCTURAL ANCHORS ═══
OPENING shape (in this order):
  1) ONE-LINE cold-hook from the day's biggest story.
  2) "Hey, welcome back to TechX TV. I'm Teja, and today we have [exact number] stories. Let's get into it."

CLOSING (final words, verbatim): "That's everything for today's episode. If something here made you think, share it with someone who'd care. See you next time."

═══ OUTPUT FORMAT — return ONLY this JSON, nothing else ═══
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
- EVERY topic in input order cover cheyyi. Skip cheyyaku, merge cheyyaku.
- Related stories IN-LINE connect cheyyi: "Idi manam intaka matladina X tho same pressure — rendu companies kuda same direction lo react avtunnayi."
- Banned lazy phrases: "in conclusion", "to summarize", "it remains to be seen", "మొత్తానికి", "anyways". Just say the thing.
- Every sentence earn its place.
- NO <think> tags, NO reasoning aloud, NO prose outside the JSON.

═══ FIXED STRUCTURAL ANCHORS ═══
OPENING shape (in this order):
  1) ONE-LINE Tenglish cold-hook from the day's biggest story.
  2) "Hey, welcome back to TechX TV. Nenu Teja, ee roju manaki [exact number] stories unnayi. Let's get into it."

CLOSING (final words, verbatim): "Ade ee episode ki. Edaina interesting ga anipiste, share it with someone who'd care. See you next time."

═══ OUTPUT FORMAT — return ONLY this JSON, nothing else ═══
{
  "script": "[Tenglish cold-hook line] Hey, welcome back to TechX TV. Nenu Teja, ee roju manaki [N] stories unnayi. Let's get into it. … [one flowing Tenglish script with open loops, framework-shaped stories, micro-resets, variable pacing] … Ade ee episode ki. Edaina interesting ga anipiste, share it with someone who'd care. See you next time."
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

TOTAL TOPICS: ${safeTopics.length}. Cover every topic in input order inside one continuous monologue. No titles, no "Topic one", no labels, no bullets — just one host talking.

The topic briefs below are PRE-ANALYZED — each one already has a SUMMARY, WHY NOW (catalyst), KEY FACTS, BIGGER PICTURE, and an HONEST TAKE. Use those as your authoritative source of truth. Do NOT re-state them mechanically — translate them into spoken narrative with the dopamine / framework / micro-reset techniques from your system prompt.

BEFORE YOU WRITE, plan silently (do NOT output the plan):
1) Pick the BIGGEST / MOST SURPRISING story across all ${safeTopics.length} topics — that one supplies the cold-hook opening line (pull the sharpest number or claim from its KEY FACTS).
2) For EACH topic, decide which framework fits:
   - Tool / software update → "What → So What → Now What"
   - AI breakthrough / research → ABT (And, But, Therefore)
   - Big tech battle / funding / drama → David vs Goliath (characters + conflict)
3) For EACH topic, pick the core emotion: Awe (AI breakthroughs), FOMO (tools), Voyeurism (drama).
4) Plan at least TWO open-loop teases — early in story X, plant a one-line hook for a later story Y, then resolve it when Y arrives.
5) Plan VARIABLE PACING: not every story gets equal length. Some get 20-30 seconds rapid-fire; one or two get a 2-3 minute deep dive.
6) Find cross-topic connections from the BIGGER PICTURE fields (same company, competing tech, same trend) — weave them in-line.

THEN WRITE THE SCRIPT executing that plan. Use varied bridges between stories (never reuse one). Insert micro-resets every ~90-120 seconds — short jabs after long setups, rhetorical questions, hard pivot cues like "Here's the part nobody is talking about." Do not echo topic titles verbatim as headlines.

Pre-analyzed topic briefs:
${safeTopics.map(renderTopicBlock).join('\n\n')}

Return ONLY {"script": "..."} — a single JSON object with one "script" string. No segments array, no titles, no other keys, no prose outside the JSON, no <think> tags, no markdown inside the script.`;

      const topicIds = topics.map((t: any) => t.id).filter(Boolean).join(',');

      const nvidiaPayload = {
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        // We instruct the model explicitly to return {"script":"..."} and parse manually.
        temperature: 0.75,
        max_tokens: 8000
      };

      const host = req.headers.get('host') || 'localhost:3000';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const callbackUrl = `${protocol}://${host}/api/analyze?isCallback=true&episodeId=${episodeId}&topicIds=${topicIds}`;

      // Deployment branching:
      //   • Vercel / serverless with short timeouts → set QSTASH_TOKEN to queue NVIDIA call.
      //   • Render / Fly / any long-running Node (or local) → run inline fire-and-forget. Same
      //     Node process handles the self-callback, so we hit 127.0.0.1 on the bound port.
      const useQStash = !!process.env.QSTASH_TOKEN;

      if (!useQStash) {
        const port = process.env.PORT || '3000';
        const selfCallbackUrl = `http://127.0.0.1:${port}/api/analyze?isCallback=true&episodeId=${episodeId}&topicIds=${topicIds}`;

        const makeRequest = async (retries = 3): Promise<void> => {
          try {
            console.log(`[Analyze] Calling NIM (${modelId}, ${language}) with ${safeTopics.length} topics (retries left: ${retries})...`);
            const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${nvidiaApiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              },
              body: JSON.stringify(nvidiaPayload)
            });

            const data = await res.json();

            if (data.error?.code === 429 && retries > 0) {
              console.log(`[Analyze] Rate limited, retrying in 5s...`);
              await new Promise(r => setTimeout(r, 5000));
              return makeRequest(retries - 1);
            }

            console.log('[Analyze] NVIDIA succeeded, firing self-callback...');
            fetch(selfCallbackUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data)
            }).catch(err => console.error('[Analyze] Self-callback error:', err));

          } catch (err) {
            console.error('[Analyze] NVIDIA fetch failed:', err);
          }
        };

        makeRequest();
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
