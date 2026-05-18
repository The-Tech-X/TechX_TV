import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Per-topic pipeline: Tavily web search → Mistral Large reasoning → structured JSON.
// This can run for a while when many topics are submitted, so give Next.js a long ceiling.
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

async function mistralAnalyze(topic: { title: string; source: string; content: string }, tavily: TavilyPayload): Promise<TopicAnalysis> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY is not set');

  const tavilyContext = [
    tavily.answer ? `WEB ANSWER: ${tavily.answer}` : '',
    (tavily.results || [])
      .slice(0, 5)
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || '').slice(0, 800)}`)
      .join('\n\n')
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
  } catch (e) {
    console.error('[Analytics] Mistral returned unparseable JSON:', raw.slice(0, 300));
    throw new Error('Failed to parse analyst JSON');
  }

  const sources = (tavily.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url }));

  return {
    summary:       String(parsed.summary || '').trim(),
    whyNow:        String(parsed.whyNow || parsed.why_now || '').trim(),
    keyFacts:      Array.isArray(parsed.keyFacts || parsed.key_facts)
                    ? (parsed.keyFacts || parsed.key_facts).map((s: any) => String(s).trim()).filter(Boolean)
                    : [],
    biggerPicture: String(parsed.biggerPicture || parsed.bigger_picture || '').trim(),
    honestTake:    String(parsed.honestTake    || parsed.honest_take    || '').trim(),
    sources,
  };
}

async function analyzeOneTopic(topic: any): Promise<{ id: string; analysis: TopicAnalysis | null; error?: string }> {
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

    // Fetch the topics. We skip ones that already have an analysis unless force=true.
    const { data: topics, error } = await supabase
      .from('updates')
      .select('*')
      .in('id', topicIds);
    if (error) throw error;

    const todo = (topics || []).filter(t => force || !t.analysis_json);
    const skipped = (topics || []).filter(t => !force && t.analysis_json);

    const results = await Promise.all(todo.map(analyzeOneTopic));

    return NextResponse.json({
      success: true,
      analyzed: results.length,
      skipped: skipped.length,
      results: [
        ...results,
        ...skipped.map(t => ({ id: t.id, analysis: t.analysis_json, skipped: true })),
      ],
    });
  } catch (e: any) {
    console.error('[Analytics] Route error:', e);
    return NextResponse.json({ error: e?.message || 'Analytics failed' }, { status: 500 });
  }
}
