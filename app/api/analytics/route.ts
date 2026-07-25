import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Agent } from 'undici';
import { RETRY_DELAYS_MS, isTransientError } from '../../lib/retry';
import { getSettings, getStageConfig, type Provider } from '../../lib/settings';
import { callChatModel, parseModelJson } from '../../lib/aiProvider';

// Phase 1: per-topic Firecrawl web search + analysis model (parallel, ~2-4 min for 10 topics)
// Phase 2: one batch scoring call to rank all topics for social media potential
export const maxDuration = 300;
export const runtime = 'nodejs';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const FIRECRAWL_URL = 'https://api.firecrawl.dev/v2/search';

// Firecrawl's search endpoint scrapes full page content for every result
// (scrapeOptions below), which can run past undici's default 5-minute
// headersTimeout/bodyTimeout — the exact failure mode already hit once in
// app/api/analyze/route.ts for the NVIDIA call ("fetch failed" with no
// further detail). Same fix: a dispatcher scoped to just this fetch.
const FIRECRAWL_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes
const firecrawlDispatcher = new Agent({
  headersTimeout:   FIRECRAWL_TIMEOUT_MS,
  bodyTimeout:      FIRECRAWL_TIMEOUT_MS,
  connectTimeout:   30_000,
  keepAliveTimeout: 60_000,
});

// The analysis model call gets the same generous watchdog budget — whichever
// provider is configured for the "analysis" stage, a slow response shouldn't
// get killed early. callChatModel (app/lib/aiProvider.ts) applies its own
// long-timeout dispatcher internally; this is just the retry loop's bound.
const MODEL_CALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

type StageConfig = { provider: Provider; model: string; apiKey: string };

// Retries a flaky upstream call with backoff, aborting any attempt that runs
// past `timeoutMs` so a stuck connection can't block the retry loop. Used for
// both the Firecrawl search and the analysis call — either one can
// transiently fail independently, so each gets its own retry budget.
async function withRetry<T>(
  label: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  onRetry?: (attempt: number, totalAttempts: number) => void,
): Promise<T> {
  const totalAttempts = RETRY_DELAYS_MS.length + 1;
  let lastError: any = null;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const ac = new AbortController();
    const watchdog = setTimeout(() => ac.abort(), timeoutMs);
    try {
      console.log(`[Analytics] ${label} (attempt ${attempt + 1}/${totalAttempts})...`);
      return await fn(ac.signal);
    } catch (err: any) {
      lastError = err;
      const transient = isTransientError(err);
      const willRetry = transient && attempt < RETRY_DELAYS_MS.length;
      console.error(
        `[Analytics] ${label} failed (attempt ${attempt + 1}, transient=${transient}):`,
        err?.code || err?.name, err?.message,
      );
      if (!willRetry) throw err;
      onRetry?.(attempt + 2, totalAttempts);
      const wait = RETRY_DELAYS_MS[attempt];
      console.log(`[Analytics] ${label} retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    } finally {
      clearTimeout(watchdog);
    }
  }
  throw lastError ?? new Error(`${label} failed`);
}

/** Persists in-flight step/source info so open pages can poll and show it live. */
async function markTopicProgress(topicId: string, patch: Record<string, any> | null) {
  const { error } = await supabase
    .from('updates')
    .update({ analysis_progress: patch })
    .eq('id', topicId);
  if (error) console.error('[Analytics] Failed to update progress for', topicId, error);
}

type TopicAnalysis = {
  summary: string;
  whyNow: string;
  keyFacts: string[];
  biggerPicture: string;
  honestTake: string;
  sources?: { title: string; url: string }[];
};

type SocialScore = {
  id: string;
  social_score: number;
  recommended_platform: 'instagram' | 'youtube' | 'none';
  social_reasoning: string;
};

type SearchResult  = { title: string; url: string; content: string; score?: number };
type SearchPayload = { answer?: string; results?: SearchResult[] };

async function firecrawlSearch(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchPayload> {
  if (!apiKey) throw new Error('No Firecrawl API key saved — add one in Settings.');

  const res = await fetch(FIRECRAWL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      // A manually-constructed undici Agent (used here for the long-timeout
      // dispatcher) doesn't auto-decompress gzip the way undici's default
      // dispatcher does — confirmed this breaks JSON parsing for another
      // provider using this exact pattern (see app/lib/aiProvider.ts).
      // Requesting no compression sidesteps it before it can bite here too.
      'Accept-Encoding': 'identity',
    },
    body: JSON.stringify({
      query,
      limit: 5,
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
    }),
    signal,
    // @ts-expect-error — undici dispatcher option, not in stock fetch types
    dispatcher: firecrawlDispatcher,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Firecrawl ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.success) {
    throw new Error(`Firecrawl error: ${data.error || 'search failed'}`);
  }

  const webResults = data.data?.web || [];
  return {
    results: webResults.map((r: any) => ({
      title:   r.title || r.metadata?.title || '',
      url:     r.url,
      content: r.markdown || r.description || '',
    })),
  };
}

async function runAnalysis(
  topic: { title: string; source: string; content: string },
  search: SearchPayload,
  config: StageConfig,
  signal?: AbortSignal,
): Promise<TopicAnalysis> {
  const searchContext = [
    search.answer ? `WEB ANSWER: ${search.answer}` : '',
    (search.results || [])
      .slice(0, 5)
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || '').slice(0, 800)}`)
      .join('\n\n'),
  ].filter(Boolean).join('\n\n');

  const systemPrompt = `You are a sharp tech analyst writing structured briefings for a podcast host.

Your job: given a single news topic plus fresh web-search context, produce a STRUCTURED analytical breakdown that explains the WHAT, the WHY, and the SO WHAT — the way a senior reporter would brief a host before they go on air.

You return ONLY this JSON object (no prose, no markdown, no <think> tags):
{
  "summary":        "2-3 sentence plain-English summary of what actually happened.",
  "whyNow":         "2-4 sentences. What pressure / competition / opportunity / trend made this happen NOW? Identify the catalyst.",
  "keyFacts":       ["concrete fact 1 with numbers/names/specifics", "fact 2", "fact 3", "fact 4", "fact 5"],
  "biggerPicture":  "2-4 sentences. What this means for the industry, the consumer, the people working in tech, the competing players. Connect dots beyond the press release.",
  "honestTake":     "1-2 sentences. Is this genuinely a big deal, hype, or complicated? A real opinion, not hedging."
}

RULES:
- Be specific. Use numbers, names, dates, model versions, dollar amounts — whatever the source gives you.
- "whyNow" must identify a causal pressure or catalyst, not just restate the news.
- "keyFacts" must be standalone facts, not generic sentences. 3-6 items, never fluff.
- "honestTake" should commit to a view, not hedge. "Hype" is a valid take.
- If the web context contradicts or extends the original article, prefer the most recent/credible info and reflect that in the analysis.
- Plain English text. No markdown, no asterisks, no bullets, no quotes around headers.`;

  const userPrompt = `TOPIC: ${topic.title}
SOURCE: ${topic.source}

ORIGINAL ARTICLE CONTENT (truncated):
${(topic.content || '(no content provided)').slice(0, 4000)}

FRESH WEB CONTEXT (Firecrawl search results, most relevant first):
${searchContext || '(no web context available)'}

Return the JSON analysis described in the system prompt. Nothing else.`;

  const raw = await callChatModel({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    userPrompt,
    maxTokens: 3000,
    temperature: 0.45,
    signal,
  });

  let parsed: any;
  try {
    parsed = parseModelJson(raw);
  } catch {
    console.error('[Analytics] Analysis model returned unparseable JSON:', raw.slice(0, 300));
    throw new Error('Failed to parse analyst JSON');
  }

  const sources = (search.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url }));

  return {
    summary:       String(parsed.summary       || '').trim(),
    whyNow:        String(parsed.whyNow        || parsed.why_now        || '').trim(),
    keyFacts:      Array.isArray(parsed.keyFacts || parsed.key_facts)
                    ? (parsed.keyFacts || parsed.key_facts).map((s: any) => String(s).trim()).filter(Boolean)
                    : [],
    biggerPicture: String(parsed.biggerPicture || parsed.bigger_picture || '').trim(),
    honestTake:    String(parsed.honestTake    || parsed.honest_take    || '').trim(),
    sources,
  };
}

async function analyzeOneTopic(
  topic: any,
  firecrawlApiKey: string,
  analysisConfig: StageConfig,
): Promise<{ id: string; analysis: TopicAnalysis | null; error?: string }> {
  const query = `${topic.title} ${topic.source || ''} news context 2026`.trim();
  let foundSources: { title: string; url: string }[] | undefined;

  try {
    await markTopicProgress(topic.id, { step: 'searching', query, updated_at: new Date().toISOString() });

    const search = await withRetry(
      `Firecrawl search for "${topic.title}"`,
      FIRECRAWL_TIMEOUT_MS,
      signal => firecrawlSearch(query, firecrawlApiKey, signal),
      (attempt, totalAttempts) => markTopicProgress(topic.id, {
        step: 'searching', query, retrying: true, attempt, totalAttempts,
        updated_at: new Date().toISOString(),
      }),
    );

    foundSources = (search.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url }));
    console.log(
      `[Analytics] Found ${foundSources.length} source(s) for "${topic.title}": ` +
      foundSources.map(s => s.url).join(', '),
    );

    // Persisted now (not after the analysis call) so WhatsApp/LinkedIn/X
    // generation — which reads this directly instead of the brief — doesn't
    // depend on the (slower, less reliable) analysis call ever succeeding.
    const scrapedContent = (search.results || []).slice(0, 5).map(r => ({
      title: r.title, url: r.url, content: (r.content || '').slice(0, 8000),
    }));
    await supabase
      .from('updates')
      .update({
        analysis_progress: { step: 'analyzing', sources: foundSources, updated_at: new Date().toISOString() },
        scraped_content: scrapedContent,
      })
      .eq('id', topic.id);

    const analysis = await withRetry(
      `Analysis (${analysisConfig.provider}/${analysisConfig.model}) for "${topic.title}"`,
      MODEL_CALL_TIMEOUT_MS,
      signal => runAnalysis(
        { title: topic.title, source: topic.source || '', content: topic.content || '' },
        search,
        analysisConfig,
        signal,
      ),
      (attempt, totalAttempts) => markTopicProgress(topic.id, {
        step: 'analyzing', sources: foundSources, retrying: true, attempt, totalAttempts,
        updated_at: new Date().toISOString(),
      }),
    );

    const { error } = await supabase
      .from('updates')
      .update({ analysis_json: analysis, analysis_progress: null })
      .eq('id', topic.id);
    if (error) console.error('[Analytics] DB save error for', topic.id, error);

    return { id: topic.id, analysis };
  } catch (e: any) {
    const message = e?.message || 'Analysis failed';
    console.error('[Analytics] Topic failed:', topic.id, topic.title, message);
    await markTopicProgress(topic.id, {
      step: 'failed', error: String(message).slice(0, 500), sources: foundSources,
      updated_at: new Date().toISOString(),
    });
    return { id: topic.id, analysis: null, error: message };
  }
}

// Phase 2: one call sees ALL topic summaries and ranks them for social potential.
// Relative ranking is the key benefit — the AI can say "topic 3 is clearly the best
// Instagram candidate *compared to the others this week*", not just in isolation.
async function runSocialScoring(
  topics: Array<{ id: string; title: string; analysis: TopicAnalysis | null }>,
  config: StageConfig,
): Promise<SocialScore[]> {
  const topicList = topics
    .map((t, i) => {
      const a = t.analysis;
      if (!a) return `[${i + 1}] ID:${t.id}\nTitle: ${t.title}\n(no analysis available)`;
      return [
        `[${i + 1}] ID:${t.id}`,
        `Title: ${t.title}`,
        `Summary: ${a.summary}`,
        `Why Now: ${a.whyNow}`,
        `Honest Take: ${a.honestTake}`,
      ].join('\n');
    })
    .join('\n\n---\n\n');

  const systemPrompt = `You are a social media editorial director for a tech creator. You have just received a batch of weekly tech news briefs. Your job is to score each one for short-form video potential on Instagram Reels and YouTube Shorts.

PLATFORM CRITERIA:

Instagram Reels — target: shares, saves, DMs
- Developer frustrations or controversies ("they actually did WHAT?")
- Hot new tools or packages with immediate "try this now" energy
- Surprising cost-saving or workflow-changing shifts
- Controversial industry decisions that make people want to share their opinion
- Strong emotional hook in the first 3 seconds

YouTube Shorts — target: high retention, curiosity gap
- Structural framework updates with a clear "before vs after"
- Deep open-source tooling with measurable benchmarks or metrics
- Stories with a natural chronological arc (problem → attempt → result)
- Topics that reward a 45-60 second explanation without feeling rushed

Score "none" when:
- The story is dry, incremental, or requires too much context to land in 60 seconds
- It's a funding round or business news with no developer-facing angle
- It's already widely covered and has no fresh angle

SCORING: Rate each topic 0.0–10.0 for overall short-form viral potential. Then assign the best platform. Be strict — only 2 or 3 topics per batch should score above 7.0. Most news is not short-form worthy.

You return ONLY a JSON array (no prose, no markdown, no <think> tags):
[
  {
    "id": "exact-uuid-from-input",
    "social_score": 8.4,
    "recommended_platform": "instagram",
    "social_reasoning": "One sentence explaining the score and platform choice."
  }
]

Return one object per topic. Preserve the exact ID strings from the input.`;

  const userPrompt = `Score and rank these ${topics.length} tech topics for short-form video potential. Compare them against each other — only the genuinely breakout stories this week deserve a score above 7.0.

${topicList}

Return the JSON array. One entry per topic. Exact IDs preserved.`;

  const raw = await callChatModel({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    userPrompt,
    maxTokens: 2000,
    temperature: 0.3,
  });

  let parsed: any[];
  try {
    parsed = parseModelJson(raw);
    if (!Array.isArray(parsed)) throw new Error('Not an array');
  } catch {
    console.error('[Analytics] Social scoring returned unparseable JSON:', raw.slice(0, 400));
    throw new Error('Failed to parse social scoring JSON');
  }

  return parsed.map((item: any) => ({
    id:                   String(item.id || ''),
    social_score:         typeof item.social_score === 'number' ? Math.min(10, Math.max(0, item.social_score)) : 0,
    recommended_platform: ['instagram', 'youtube', 'none'].includes(item.recommended_platform)
                            ? item.recommended_platform
                            : 'none',
    social_reasoning:     String(item.social_reasoning || '').trim(),
  }));
}

export async function POST(req: Request) {
  try {
    const { topicIds, force, skipScoring, dateFrom, dateTo } = await req.json();

    const settings = await getSettings();
    const analysisConfig = await getStageConfig('analysis');

    if (!settings.firecrawl_api_key) {
      return NextResponse.json({ error: 'No Firecrawl API key saved — add one in Settings.' }, { status: 500 });
    }
    if (!analysisConfig.apiKey) {
      return NextResponse.json({ error: `No ${analysisConfig.provider} API key saved — add one in Settings.` }, { status: 500 });
    }

    // ── Score-only mode: no Phase 1 — batch-scores whatever's already
    //    analyzed within a date range. Used by the "Score this range" action,
    //    decoupled from the (now automatic, per-topic) brief generation. ─────
    if (dateFrom && dateTo) {
      const { data: topics, error } = await supabase
        .from('updates')
        .select('*')
        .not('analysis_json', 'is', null)
        .gte('created_at', `${dateFrom}T00:00:00.000Z`)
        .lte('created_at', `${dateTo}T23:59:59.999Z`);
      if (error) throw error;
      if (!topics || topics.length === 0) {
        return NextResponse.json({ error: 'No analyzed topics found in that date range' }, { status: 404 });
      }

      const allForScoring = topics.map(t => ({
        id:       t.id,
        title:    t.title,
        analysis: t.analysis_json as TopicAnalysis,
      }));
      const socialScores = await runSocialScoring(allForScoring, analysisConfig);

      await Promise.all(
        socialScores.map(s =>
          supabase
            .from('updates')
            .update({
              social_score:          s.social_score,
              recommended_platform:  s.recommended_platform,
              social_reasoning:      s.social_reasoning,
            })
            .eq('id', s.id),
        ),
      );

      return NextResponse.json({ success: true, scored: socialScores.length, results: socialScores });
    }

    // ── Standard mode: Phase 1 per-topic analysis, optionally followed by
    //    Phase 2 batch scoring (skipped when skipScoring is true — used by
    //    the auto-trigger fired the moment a single topic is added, where
    //    there's nothing yet to compare it against). ──────────────────────
    if (!Array.isArray(topicIds) || topicIds.length === 0) {
      return NextResponse.json({ error: 'topicIds (string[]) is required' }, { status: 400 });
    }

    const { data: topics, error } = await supabase
      .from('updates')
      .select('*')
      .in('id', topicIds);
    if (error) throw error;

    const todo    = (topics || []).filter(t => force || !t.analysis_json);
    const skipped = (topics || []).filter(t => !force && t.analysis_json);

    // ── Phase 1: per-topic analysis (parallel) ───────────────────────────────
    const phase1Results = await Promise.all(
      todo.map(t => analyzeOneTopic(t, settings.firecrawl_api_key, analysisConfig)),
    );

    if (skipScoring) {
      return NextResponse.json({
        success:  true,
        analyzed: phase1Results.length,
        skipped:  skipped.length,
        results: [
          ...phase1Results.map(r => ({ id: r.id, analysis: r.analysis, error: r.error, skipped: false, social: null })),
          ...skipped.map(t => ({ id: t.id, analysis: t.analysis_json, skipped: true, social: null })),
        ],
      });
    }

    // Merge phase 1 results with skipped topics for phase 2 input
    const allForScoring: Array<{ id: string; title: string; analysis: TopicAnalysis | null }> = [
      ...phase1Results.map(r => ({
        id:       r.id,
        title:    todo.find(t => t.id === r.id)?.title || '',
        analysis: r.analysis,
      })),
      ...skipped.map(t => ({
        id:       t.id,
        title:    t.title,
        analysis: t.analysis_json as TopicAnalysis,
      })),
    ];

    // ── Phase 2: batch social scoring (one call sees all topics) ─────────────
    let socialScores: SocialScore[] = [];
    try {
      socialScores = await runSocialScoring(allForScoring, analysisConfig);

      // Persist social scores back to each update row
      await Promise.all(
        socialScores.map(s =>
          supabase
            .from('updates')
            .update({
              social_score:          s.social_score,
              recommended_platform:  s.recommended_platform,
              social_reasoning:      s.social_reasoning,
            })
            .eq('id', s.id),
        ),
      );
      console.log(`[Analytics] Social scoring complete for ${socialScores.length} topics`);
    } catch (e: any) {
      // Social scoring failure is non-fatal — Phase 1 results are already saved
      console.error('[Analytics] Phase 2 social scoring failed (non-fatal):', e?.message);
    }

    // Build response — merge analysis + social scores for each topic
    const scoreMap = new Map(socialScores.map(s => [s.id, s]));

    const enrichResult = (id: string, analysis: TopicAnalysis | null, isSkipped = false) => ({
      id,
      analysis,
      skipped: isSkipped,
      social: scoreMap.get(id) ?? null,
    });

    return NextResponse.json({
      success:  true,
      analyzed: phase1Results.length,
      skipped:  skipped.length,
      results: [
        ...phase1Results.map(r => enrichResult(r.id, r.analysis)),
        ...skipped.map(t => enrichResult(t.id, t.analysis_json, true)),
      ],
    });
  } catch (e: any) {
    console.error('[Analytics] Route error:', e);
    return NextResponse.json({ error: e?.message || 'Analytics failed' }, { status: 500 });
  }
}
