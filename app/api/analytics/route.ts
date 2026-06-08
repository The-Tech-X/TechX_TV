import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Phase 1: per-topic Tavily + Mistral (parallel, ~2-4 min for 10 topics)
// Phase 2: one batch Mistral call to rank all topics for social media potential
export const maxDuration = 300;
export const runtime = 'nodejs';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const TAVILY_URL    = 'https://api.tavily.com/search';
const NIM_URL       = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MISTRAL_MODEL = 'mistralai/mistral-large-3-675b-instruct-2512';

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

type TavilyResult  = { title: string; url: string; content: string; score?: number };
type TavilyPayload = { answer?: string; results?: TavilyResult[] };

async function tavilySearch(query: string): Promise<TavilyPayload> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY is not set');

  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'advanced',
      include_answer: true,
      max_results: 6,
      include_raw_content: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tavily ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function mistralAnalyze(
  topic: { title: string; source: string; content: string },
  tavily: TavilyPayload,
): Promise<TopicAnalysis> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY is not set');

  const tavilyContext = [
    tavily.answer ? `WEB ANSWER: ${tavily.answer}` : '',
    (tavily.results || [])
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

FRESH WEB CONTEXT (Tavily search results, most relevant first):
${tavilyContext || '(no web context available)'}

Return the JSON analysis described in the system prompt. Nothing else.`;

  const res = await fetch(NIM_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.45,
      max_tokens: 3000,
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Mistral ${res.status}: ${(data.error?.message || JSON.stringify(data)).slice(0, 200)}`);
  }

  let raw: string = data.choices?.[0]?.message?.content ?? '';
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : raw;

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error('[Analytics] Mistral returned unparseable JSON:', raw.slice(0, 300));
    throw new Error('Failed to parse analyst JSON');
  }

  const sources = (tavily.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url }));

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
): Promise<{ id: string; analysis: TopicAnalysis | null; error?: string }> {
  try {
    const query = `${topic.title} ${topic.source || ''} news context 2026`.trim();
    const tavily = await tavilySearch(query);
    const analysis = await mistralAnalyze(
      { title: topic.title, source: topic.source || '', content: topic.content || '' },
      tavily,
    );

    const { error } = await supabase
      .from('updates')
      .update({ analysis_json: analysis })
      .eq('id', topic.id);
    if (error) console.error('[Analytics] DB save error for', topic.id, error);

    return { id: topic.id, analysis };
  } catch (e: any) {
    console.error('[Analytics] Topic failed:', topic.id, topic.title, e?.message);
    return { id: topic.id, analysis: null, error: e?.message || 'Analysis failed' };
  }
}

// Phase 2: one Mistral call sees ALL topic summaries and ranks them for social potential.
// Relative ranking is the key benefit — the AI can say "topic 3 is clearly the best
// Instagram candidate *compared to the others this week*", not just in isolation.
async function runSocialScoring(
  topics: Array<{ id: string; title: string; analysis: TopicAnalysis | null }>,
): Promise<SocialScore[]> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY is not set');

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

  const res = await fetch(NIM_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Mistral social scoring ${res.status}: ${(data.error?.message || JSON.stringify(data)).slice(0, 200)}`);
  }

  let raw: string = data.choices?.[0]?.message?.content ?? '';
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Extract JSON array from response
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  const jsonStr = arrMatch ? arrMatch[0] : raw;

  let parsed: any[];
  try {
    parsed = JSON.parse(jsonStr);
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
    const { topicIds, force } = await req.json();

    if (!Array.isArray(topicIds) || topicIds.length === 0) {
      return NextResponse.json({ error: 'topicIds (string[]) is required' }, { status: 400 });
    }
    if (!process.env.TAVILY_API_KEY) {
      return NextResponse.json({ error: 'TAVILY_API_KEY missing on server' }, { status: 500 });
    }
    if (!process.env.NVIDIA_API_KEY) {
      return NextResponse.json({ error: 'NVIDIA_API_KEY missing on server' }, { status: 500 });
    }

    const { data: topics, error } = await supabase
      .from('updates')
      .select('*')
      .in('id', topicIds);
    if (error) throw error;

    const todo    = (topics || []).filter(t => force || !t.analysis_json);
    const skipped = (topics || []).filter(t => !force && t.analysis_json);

    // ── Phase 1: per-topic analysis (parallel) ───────────────────────────────
    const phase1Results = await Promise.all(todo.map(analyzeOneTopic));

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

    // ── Phase 2: batch social scoring (one Mistral call sees all topics) ─────
    let socialScores: SocialScore[] = [];
    try {
      socialScores = await runSocialScoring(allForScoring);

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
