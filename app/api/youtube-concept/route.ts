import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getStageConfig } from '../../lib/settings';
import { callChatModel, parseModelJson } from '../../lib/aiProvider';

export const maxDuration = 180;
export const runtime = 'nodejs';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const CONCEPT_SYSTEM_PROMPT = `You are a YouTube content strategist for TechX TV, a tech creator channel hosted by Teja.

You receive a batch of tech news summaries from the past 2–3 weeks. Your job is to identify the best YouTube video opportunity from this material.

You always return TWO options:

OPTION A — SYNTHESIZED CONCEPT:
Look across all topics for a theme, tension, or pattern that no single story tells on its own. The best concepts emerge when 3–5 stories, read together, reveal something bigger: a shift in how the industry works, a contradiction between what companies say and what they do, or a new risk that's been quietly building. The video should answer a question the viewer didn't know they had.

OPTION B — BEST SINGLE TOPIC:
If one story clearly outperforms the others for long-form treatment — a major release, a paradigm shift, or a story with enough depth to sustain 5–8 minutes — surface it as a standalone video pick. Be honest: if no single story is strong enough, say so in the reasoning.

For whichever option is stronger, provide a full outline: title, thesis, and 4–6 section headings with a one-sentence description of what each section covers.

RULES:
- Synthesized is usually stronger. Only pick best_single if it's genuinely exceptional.
- The title should be a specific claim or question, not a vague topic label.
- The thesis is the ONE thing the viewer should understand by the end.
- Outline sections should feel like a natural narrative arc, not a bullet list.
- Be direct about which option you think is stronger and why.

Return ONLY this JSON (no prose, no markdown, no <think> tags):
{
  "synthesized": {
    "title": "specific video title as a claim or question",
    "thesis": "the one core argument the video makes",
    "why": "1-2 sentences on why this angle works and which stories it draws from",
    "outline": [
      { "section": "section title", "description": "what this section covers in one sentence" }
    ]
  },
  "best_single": {
    "update_id": "uuid of the strongest single topic, or null if none stands out",
    "title": "proposed video title for this topic",
    "why": "1-2 sentences on why this topic can sustain a full video"
  },
  "recommendation": "synthesized or best_single",
  "recommendation_reason": "one sentence on why you recommend that option"
}`;

export async function POST(req: Request) {
  try {
    const { dateFrom, dateTo } = await req.json();

    if (!dateFrom || !dateTo) {
      return NextResponse.json({ error: 'dateFrom and dateTo are required' }, { status: 400 });
    }

    const config = await getStageConfig('youtube_concept');
    if (!config.apiKey) {
      return NextResponse.json({ error: `No ${config.provider} API key saved — add one in Settings.` }, { status: 500 });
    }

    // Fetch all analyzed updates in the date range
    const { data: updates, error: fetchErr } = await supabase
      .from('updates')
      .select('id, title, source, analysis_json, social_score, recommended_platform')
      .gte('created_at', `${dateFrom}T00:00:00.000Z`)
      .lte('created_at', `${dateTo}T23:59:59.999Z`)
      .not('analysis_json', 'is', null)
      .order('created_at', { ascending: true });

    if (fetchErr) throw fetchErr;
    if (!updates || updates.length === 0) {
      return NextResponse.json({ error: 'No analyzed topics found in this date range' }, { status: 404 });
    }

    const topicList = updates.map((u, i) => {
      const a = u.analysis_json;
      return [
        `[${i + 1}] ID: ${u.id}`,
        `Title: ${u.title}`,
        `Summary: ${a?.summary || 'N/A'}`,
        `Why Now: ${a?.whyNow || 'N/A'}`,
        `Bigger Picture: ${a?.biggerPicture || 'N/A'}`,
        `Honest Take: ${a?.honestTake || 'N/A'}`,
      ].join('\n');
    }).join('\n\n---\n\n');

    const userPrompt = `Analyze these ${updates.length} tech stories from the past ${dateFrom} to ${dateTo} and identify the best YouTube video opportunity.

${topicList}

Return the concept JSON. Use exact UUIDs from the input for best_single.update_id.`;

    const raw = await callChatModel({
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt: CONCEPT_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 3000,
      temperature: 0.5,
    });

    let conceptJson: any;
    try {
      conceptJson = parseModelJson(raw);
    } catch {
      console.error(`[YouTubeConcept] ${config.provider}/${config.model} returned unparseable JSON:`, raw.slice(0, 300));
      throw new Error('Failed to parse concept JSON from model');
    }

    // Save to youtube_concepts table
    const { data: saved, error: saveErr } = await supabase
      .from('youtube_concepts')
      .insert({
        date_from:    dateFrom,
        date_to:      dateTo,
        update_ids:   updates.map(u => u.id),
        concept_json: conceptJson,
        status:       'concept_ready',
      })
      .select()
      .single();

    if (saveErr) console.error('[YouTubeConcept] Save error:', saveErr);

    return NextResponse.json({
      success: true,
      conceptId: saved?.id,
      concept: conceptJson,
      topicCount: updates.length,
    });
  } catch (e: any) {
    console.error('[YouTubeConcept] Error:', e);
    return NextResponse.json({ error: e?.message || 'Concept generation failed' }, { status: 500 });
  }
}
