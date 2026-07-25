import { NextResponse } from 'next/server';
import { Client } from '@upstash/qstash';
import { createClient } from '@supabase/supabase-js';
import { Agent } from 'undici';
import { RETRY_DELAYS_MS, isTransientError } from '../../lib/retry';
import { getStageConfig, type Provider } from '../../lib/settings';
import { buildProviderRequest, extractRawText, extractFinishReason } from '../../lib/aiProvider';

// The model call can run for many minutes — give the route handler headroom.
export const runtime = 'nodejs';
export const maxDuration = 60;

// Long-running LLM calls — Llama-3.1-70B (the default "podcast" model) with 8
// topics and 8000 max_tokens regularly takes 6-10 minutes to return its first
// byte. Undici's default headersTimeout/bodyTimeout of 5 minutes was killing
// the request on Render with UND_ERR_HEADERS_TIMEOUT before it could respond.
// This dispatcher is scoped to this fetch only so Firecrawl / Supabase keep
// their snappy defaults.
const NVIDIA_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const nvidiaDispatcher = new Agent({
  headersTimeout: NVIDIA_TIMEOUT_MS,
  bodyTimeout:    NVIDIA_TIMEOUT_MS,
  connectTimeout: 30_000,
  keepAliveTimeout: 60_000,
});

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
      const responseFormat = url.searchParams.get('format') === 'text' ? 'text' : 'json';
      // Which provider generated this response — stamped into the callback
      // URL when the trigger branch fired, so the (differently-shaped) raw
      // response body can be parsed correctly regardless of which provider
      // is configured for the "podcast" stage. Defaults to 'nvidia' so any
      // callback already in flight from before this field existed still parses.
      const provider = (url.searchParams.get('provider') || 'nvidia') as Provider;

      if (!episodeWeekId) {
        return NextResponse.json({ error: 'Missing episodeId in callback' }, { status: 400 });
      }

      let body: any;
      try {
        body = await req.json();
      } catch (parseErr: any) {
        const errMsg = `Callback received non-JSON body from ${provider}: ${parseErr.message}`;
        console.error('[Callback]', errMsg);
        await supabase.from('episodes').upsert(
          { week_id: episodeWeekId, analysis_json: { status: 'failed', error: errMsg.slice(0, 500), failed_at: new Date().toISOString() }, updated_at: new Date().toISOString() },
          { onConflict: 'week_id' },
        );
        return NextResponse.json({ error: errMsg }, { status: 502 });
      }

      let rawContent: string = extractRawText(provider, body);
      const finishReason: string | undefined = extractFinishReason(provider, body);
      const truncatedByModel = finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'MAX_TOKENS';

      if (!rawContent) {
        console.error('[Callback] Invalid AI response structure', JSON.stringify(body).slice(0, 500));
        return NextResponse.json({ error: 'Invalid AI response' }, { status: 500 });
      }

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
        // Plain-text branch — model returns bare prose instead of JSON.
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

      // Fetch existing analysis_json so we can merge — preserves language, topic_ids,
      // model and any other metadata written during the 'generating' phase.
      const { data: existingEp } = await supabase
        .from('episodes')
        .select('analysis_json')
        .eq('week_id', episodeWeekId)
        .maybeSingle();

      const existingMeta = existingEp?.analysis_json || {};
      analysisJson = {
        ...existingMeta,
        status: 'done',
        finish_reason: finishReason,
        ...(recoveryNote ? { recovery_note: recoveryNote } : {}),
      };
      // script_text column holds the script; no need to duplicate it in analysis_json.

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
      const { episodeId, topics } = body;

      if (!episodeId || !topics?.length) {
        return NextResponse.json({ error: 'Missing episodeId or topics' }, { status: 400 });
      }

      const { provider, model: modelId, apiKey: providerApiKey } = await getStageConfig('podcast');
      if (!providerApiKey) {
        return NextResponse.json({ error: `No ${provider} API key saved — add one in Settings.` }, { status: 500 });
      }

      const englishSystemPrompt = `You are Teja, the host of TechX TV — a sharp, no-fluff tech podcast for people who want to understand what's actually happening in the industry and why it matters to them personally.

Your job is to write ONE flowing spoken script that sounds like a brilliant friend explaining the week's biggest tech stories over coffee. Not a newsreader. Not a summarizer. A storyteller who knows which details land and which ones to cut.

═══ THE THREE FIXED LINES — USE THESE VERBATIM, NOTHING ELSE IS FIXED ═══

OPENING LINE (always second, after the cold hook):
"Hey, welcome back to The TechX TV. I'm Teja — [a short punchy line about what's in today's episode]. Let's get into it."

CLOSING LINE (always last two lines):
"That's everything for today — from [callback to cold open story] to [callback to final story]. [One-line theme that ties the whole episode.] If something here hit different, send it to someone who needs to hear it. See you next time. This is Teja, from The TechX TV."

These three lines are sacred. Everything between them is yours to shape.

═══ COLD OPEN — the first 20 seconds decide everything ═══

Line one of the script is NEVER a greeting. It is a one-line gut-punch from the day's most surprising story — a specific number, a shocking action, a contradiction that makes someone stop scrolling.

ILLUSTRATION ONLY — these are fictional examples to show the FORMAT, do NOT copy or paraphrase them:
  WRONG FORMAT: "Today we're covering some really big developments in AI."
  WRONG FORMAT: "A lot happened this week in tech, so let's get into it."
  RIGHT FORMAT:  "[Specific dollar amount] just disappeared — and the AI that spent it didn't ask."
  RIGHT FORMAT:  "[Company] just stacked [number] layers into a chip the size of your thumbnail."
Your cold hook must be built from the REAL stories in today's topics, not from these illustrations.

The cold hook is a fact, not a tease. Say the thing. Then immediately go into the opening line.

═══ THE CLOSING — a proper landing, not a flat goodbye ═══

The closing is not a summary list. It is a bookend. It calls back to the cold open story AND the final story, then pulls one thread that connects everything in the episode — the underlying theme, the tension, the thing that makes this particular set of stories feel like one coherent moment in time. Then the sign-off.

ILLUSTRATION ONLY — shows the FORMAT, do NOT copy or paraphrase:
  WRONG FORMAT: "That's everything for today's episode. If something here made you think, share it with someone who'd care. See you next time."
  RIGHT FORMAT:  "That's everything for today — from [cold open story callback] to [final story callback]. [One unifying theme sentence]. If something here hit different, send it to someone who needs to hear it. See you next time. This is Teja, from The TechX TV."
Fill in the bracketed placeholders with the REAL stories from today's episode.

The closing earns its place. One punchy theme sentence. Then out.

═══ TRANSITIONS — the hardest part, and the most important ═══

Every transition between stories must be EARNED. The listener should feel like one idea is naturally pulling them toward the next — not like the host is reading from a list.

BANNED TRANSITIONS — never use these, ever:
- "Now, let's talk about..."
- "Next up..."
- "Moving on..."
- "Let's switch gears..."
- "Now let's discuss..."
- "Speaking of which..." (unless the connection is genuinely specific and earned)
- Any variant of "But here's the thing" more than once per episode
- "But what does this mean for the industry?"

INSTEAD — earn the transition one of these ways. The lines below show STRUCTURE only — never copy them; build yours from the actual stories in today's episode:

[1] THEMATIC PULL — the next story is the natural consequence or contrast of the previous one.
(structure) "[Story A conclusion]. Which brings us directly to [Company/Topic B]..."

[2] TENSION PLANT — end one story with a question, answer it in the next.
(structure) "The real question isn't [X]. It's [Y] — and this week, we got the clearest answer yet."

[3] ZOOM OUT / ZOOM IN — shift the lens, not the topic.
(structure) "Zoom out from [layer A] for a second. While [story A trend] is happening, a different battle is playing out at [layer B]."

[4] CONTRAST CUT — place two opposing ideas back to back, let the contrast do the work.
(structure) "So on one side: [story A position]. On the other: [story B position]."

[5] DIRECT PIVOT (for unrelated stories) — just be honest about the gear shift, but make it crisp.
(structure) "Completely different corner of the industry, but worth your attention:"

Each transition is different. The listener should never be able to predict the shape of the next one.

═══ HOW TO WRITE EACH STORY — sharpness over completeness ═══

The goal is never to give the listener everything. The goal is to give them the ONE thing that makes this story matter right now, plus the consequence they haven't thought of yet.

Every story has three layers. Hit all three, in as few words as it takes:

[1] THE SURFACE — what actually happened. Specific. No vague language.
BAD FORMAT: "There have been some developments in [space]."
GOOD FORMAT: "[Actor] did [specific thing] — [specific number/detail]."

[2] THE TWIST — the thing that makes this surprising, contradictory, or bigger than it looks.
BAD FORMAT: "This has implications for the industry."
GOOD FORMAT: "[The surprising implication] — which means [consequence]."

[3] THE STAKE — what this means for a real person, a real company, or a real decision being made right now.
BAD FORMAT: "Competitors will likely respond."
GOOD FORMAT: "Every [affected group] just [inherited consequence] — without knowing it."

Use the REAL facts from today's topic briefs to fill these shapes. Never copy the format illustrations verbatim.

Write the three layers in as few sentences as they need. A small story gets two sharp sentences. A big story gets a paragraph. Neither gets padding.

═══ BANNED PHRASES — never write these ═══

These phrases are filler. They signal that the writer ran out of things to say and kept typing anyway. Cut them:

- "But here's the thing" (maximum once per episode, use sparingly)
- "But what does this mean for the industry?"
- "This marks a shift"
- "This signals a new era"
- "It remains to be seen"
- "In conclusion" / "To summarize"
- "At the end of the day"
- "This is huge"
- "Game-changer"
- "Revolutionary"
- "Incredibly"
- "Really interesting"
- Any sentence that starts with "So, basically..."

If you feel like writing one of these, ask yourself what you actually mean and write that instead.

═══ VOICE — who Teja is ═══

Teja is the smartest friend you have who happens to work in tech. He explains things the way you'd explain them to someone smart but not a specialist — no condescension, no unnecessary jargon, no hedging. He has opinions but doesn't moralize. He finds the human consequence in every technical story.

His sentences vary wildly in length. A long setup. Then a short jab. Then a question. A fact. The rhythm keeps the listener awake.

He uses rhetorical questions to reset attention: "Why now? Because the cost just hit zero." "What changed? Everything upstream of the application layer."

He never says "incredible" or "amazing." He trusts the facts to do that work.

Depth of Acquired. Directness of Vergecast. Warmth of How I Built This. No hype.

═══ STORY ORDER — you decide, not the input ═══

The input is a list, not a running order. You are the editor. Every topic in the input must appear in the script — no skipping, no merging. Weight, order, and pacing are yours to shape; coverage is not. You decide:
- Which story is the strongest cold open hook?
- Which stories belong next to each other because they're in tension or in conversation?
- Which story is the best "slow burn" that deserves a longer beat?
- Which story lands best near the end — memorable but not the heaviest?
- Where can you plant a tease for a later story, then pay it off?

Group related stories so transitions are natural. Never stack two slow analytical stories back to back. End strong — not with the biggest story, but with the most resonant one.

═══ PACING — variable, always ═══

Not every story gets the same weight. The episode should feel like:
- A strong cold open (15-20 seconds)
- Two or three stories that build quickly (30-45 seconds each)
- One or two deep dives where the stakes demand it (90-120 seconds)
- A couple of sharp one-liners that move fast
- A closing that lands properly (20-30 seconds)

Predictable pacing is the enemy. The listener's brain checks out when it knows what's coming next.

═══ CROSS-STORY CONNECTIONS — weave, don't repeat ═══

When two stories share a pressure, a company, a trend, or a consequence — connect them inline while you're telling the second story. One sentence. Don't re-explain the first story, just pull the thread.

(structure only) "This is the same pressure we saw with [story A] — both moves are [shared consequence]."

Build the connection from the REAL stories in today's briefs. Only do this when the connection is genuine and specific. Forced connections are worse than no connections.

═══ LENGTH — driven by the story, never by a quota ═══

No word count. No target runtime. Each story gets exactly as much space as it earns:
- A minor update or a scoop? Two sharp sentences and a pivot.
- A genuine inflection point — a model release, a billion-dollar move, a research breakthrough that changes threat models? A paragraph or two with surface, twist, and stake.

Never pad. Never repeat a point in different words. If a sentence has no new information in it, cut it.

═══ OUTPUT FORMAT ═══

Return ONLY this JSON. The first character of your response is "{". No greeting, no plan, no preamble, no markdown fence, no <think> tags. Just the JSON.

{
  "script": "[cold hook line] Hey, welcome back to The TechX TV. I'm Teja — [punchy episode framing]. Let's get into it. … [one flowing script] … That's everything for today — from [cold open callback] to [final story callback]. [One-line theme.] If something here hit different, send it to someone who needs to hear it. See you next time. This is Teja, from The TechX TV."
}`;


      const systemPrompt = englishSystemPrompt;

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

      const languageInstruction = `Language: ENGLISH — plain English, no other language.`;

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

      // Every provider is asked for the same {"script": "..."} shape and
      // parsed the same way (extractRawText + JSON parse below).
      const callbackFormat: 'json' | 'text' = 'json';
      const { url: providerUrl, headers: providerHeaders, body: providerPayload } = buildProviderRequest({
        provider, apiKey: providerApiKey, model: modelId,
        systemPrompt, userPrompt,
        temperature: 0.75, maxTokens: 8000,
      });

      const host = req.headers.get('host') || 'localhost:3000';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const callbackUrl = `${protocol}://${host}/api/analyze?isCallback=true&episodeId=${episodeId}&topicIds=${topicIds}&format=${callbackFormat}&provider=${provider}`;

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
        const selfCallbackUrl = `http://127.0.0.1:${port}/api/analyze?isCallback=true&episodeId=${episodeId}&topicIds=${topicIds}&format=${callbackFormat}&provider=${provider}`;

        // Record that this episode is in-flight before we kick off the long
        // model call. If the user navigates away (or the call fails), the UI
        // can read this status and offer a Retry button.
        await markEpisodeStatus(episodeId, {
          status: 'generating',
          model: modelId,
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
                `[Analyze] Calling ${provider} (${modelId}) with ${safeTopics.length} topics ` +
                `(attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1})...`
              );

              const res = await fetch(providerUrl, {
                method: 'POST',
                // A manually-constructed undici Agent (this dispatcher) doesn't
                // auto-decompress gzip the way undici's default dispatcher
                // does — confirmed this breaks JSON parsing for Gemini via this
                // exact pattern (see app/lib/aiProvider.ts). No-compression
                // sidesteps it regardless of which provider is configured here.
                headers: { ...providerHeaders, 'Accept-Encoding': 'identity' },
                body: JSON.stringify(providerPayload),
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
                console.log(`[Analyze] ${provider} responded ${res.status} (${upstreamRateLimited ? 'rate-limited' : 'server error'}), retrying in ${wait / 1000}s...`);
                lastError = new Error(`${provider} HTTP ${res.status}`);
                await new Promise(r => setTimeout(r, wait));
                continue;
              }

              if (!res.ok || data.error) {
                throw new Error(
                  `${provider} HTTP ${res.status}: ${data.error?.message || JSON.stringify(data).slice(0, 300)}`
                );
              }

              console.log(`[Analyze] ${provider} succeeded, firing self-callback...`);
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
                `[Analyze] ${provider} fetch failed (attempt ${attempt + 1}, transient=${transient}):`,
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
          url: providerUrl,
          method: 'POST',
          headers: { ...providerHeaders, 'Accept': 'application/json' },
          body: providerPayload,
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
