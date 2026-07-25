import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { PLATFORMS, type Platform } from './prompts';
import { getStageConfig } from '../../lib/settings';
import { callChatModel, parseModelJson } from '../../lib/aiProvider';

export const maxDuration = 120;
export const runtime = 'nodejs';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLATFORMS, value);
}

export async function POST(req: Request) {
  try {
    const { updateId, platform, note, conceptOverride } = await req.json();

    if (!platform) {
      return NextResponse.json({ error: 'platform is required' }, { status: 400 });
    }
    if (!isPlatform(platform)) {
      return NextResponse.json(
        { error: `platform must be one of: ${Object.keys(PLATFORMS).join(', ')}` },
        { status: 400 }
      );
    }

    const { stage, systemPrompt, maxTokens } = PLATFORMS[platform];
    const config = await getStageConfig(stage);

    if (!config.apiKey) {
      return NextResponse.json(
        { error: `No ${config.provider} API key saved for this stage — add one in Settings.` },
        { status: 500 }
      );
    }

    let userPrompt: string;
    const saveUpdateId: string | null = updateId || null;
    const saveConceptId: string | null = conceptOverride?.conceptId || null;

    if (conceptOverride?.prompt) {
      // YouTube concept path — prompt built by the UI
      userPrompt = conceptOverride.prompt;
    } else {
      if (!updateId) {
        return NextResponse.json({ error: 'updateId is required for single-topic scripts' }, { status: 400 });
      }

      const { data: update, error: fetchErr } = await supabase
        .from('updates')
        .select('*')
        .eq('id', updateId)
        .single();
      if (fetchErr || !update) {
        return NextResponse.json({ error: 'Update not found' }, { status: 404 });
      }

      if (stage === 'quick_posts') {
        if (!Array.isArray(update.scraped_content) || update.scraped_content.length === 0) {
          return NextResponse.json(
            { error: 'No scraped source content for this topic yet — run analytics on it first' },
            { status: 400 }
          );
        }
      } else if (!update.analysis_json) {
        return NextResponse.json({ error: 'Run analytics on this topic first' }, { status: 400 });
      }

      userPrompt = PLATFORMS[platform].buildUserPrompt(update, note);
    }

    const raw = await callChatModel({
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      userPrompt,
      maxTokens,
      temperature: 0.65,
      // quick_posts (linkedin/whatsapp/x) are short repackaging tasks by
      // design — deep reasoning isn't needed, and Gemini's thinking tokens
      // were confirmed (via live testing) to blow through their smaller
      // token budgets otherwise.
      disableThinking: stage === 'quick_posts',
    });

    let scriptJson: any;
    try {
      scriptJson = parseModelJson(raw);
    } catch {
      console.error(`[SocialScript] ${config.provider}/${config.model} returned unparseable JSON:`, raw.slice(0, 300));
      throw new Error('Failed to parse script JSON from model');
    }

    // Models are unreliable at exact character counting (confirmed: one real
    // generation came back at 304 chars despite the prompt's 280-char rule)
    // — X rejects anything over the limit outright, so clamp server-side
    // rather than trust the model's own count.
    if (platform === 'x' && typeof scriptJson?.content === 'string' && scriptJson.content.length > 280) {
      const cut = scriptJson.content.slice(0, 279);
      const lastSpace = cut.lastIndexOf(' ');
      scriptJson.content = (lastSpace > 200 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
    }

    // Upsert (not insert) — regenerating a platform for a topic overwrites
    // the existing row instead of erroring on the (update_id, platform)
    // unique constraint. Concept-derived scripts (update_id null) fall
    // outside the constraint since Postgres treats NULLs as distinct, so
    // they insert fresh each time, same as before this change.
    const { data: saved, error: saveErr } = await supabase
      .from('social_scripts')
      .upsert(
        {
          update_id:          saveUpdateId,
          youtube_concept_id: saveConceptId,
          platform,
          script_json:        scriptJson,
          status:             'done',
          note:               note || null,
        },
        { onConflict: 'update_id,platform' }
      )
      .select()
      .single();

    if (saveErr) {
      console.error('[SocialScript] Save error:', saveErr);
      return NextResponse.json(
        { success: false, script: scriptJson, error: `Generated but failed to save: ${saveErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, script: scriptJson, id: saved?.id });
  } catch (e: any) {
    console.error('[SocialScript] Error:', e);
    return NextResponse.json({ error: e?.message || 'Script generation failed' }, { status: 500 });
  }
}
