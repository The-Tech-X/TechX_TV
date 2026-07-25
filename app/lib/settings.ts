import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export type Provider = 'nvidia' | 'openai' | 'gemini' | 'claude';

/** One API key per provider (shared across every pipeline stage that picks
 * that provider) + one non-LLM key (Firecrawl, web search) + one
 * provider/model pair per pipeline stage — each stage is independently
 * switchable to any provider without touching the others. */
export type SettingKey =
  | 'nvidia_api_key'
  | 'openai_api_key'
  | 'gemini_api_key'
  | 'claude_api_key'
  | 'firecrawl_api_key'
  | 'analysis_provider'        | 'analysis_model'        // /api/analytics — topic briefs + social scoring
  | 'podcast_provider'         | 'podcast_model'          // /api/analyze — podcast script
  | 'social_scripts_provider'  | 'social_scripts_model'   // /api/social-script — Instagram/YouTube
  | 'youtube_concept_provider' | 'youtube_concept_model'  // /api/youtube-concept
  | 'quick_posts_provider'     | 'quick_posts_model';     // /api/social-script — LinkedIn/WhatsApp/X

// Falls back to the env var of the same name whenever /settings has no saved
// value yet, so existing env-var-based deployments (Render, etc.) keep
// working unchanged until someone actually edits a value in the UI.
const ENV_FALLBACK: Partial<Record<SettingKey, string | undefined>> = {
  nvidia_api_key:    process.env.NVIDIA_API_KEY,
  openai_api_key:    process.env.OPENAI_API_KEY,
  gemini_api_key:    process.env.GEMINI_API_KEY,
  claude_api_key:    process.env.ANTHROPIC_API_KEY,
  firecrawl_api_key: process.env.FIRECRAWL_API_KEY,
};

const HARDCODED_DEFAULTS: Record<SettingKey, string> = {
  nvidia_api_key:    '',
  openai_api_key:    '',
  gemini_api_key:    '',
  claude_api_key:    '',
  firecrawl_api_key: '',

  analysis_provider:        'nvidia', analysis_model:        'mistralai/mistral-medium-3.5-128b',
  podcast_provider:         'nvidia', podcast_model:         'meta/llama-3.1-70b-instruct',
  social_scripts_provider:  'nvidia', social_scripts_model:  'mistralai/mistral-medium-3.5-128b',
  youtube_concept_provider: 'nvidia', youtube_concept_model: 'mistralai/mistral-medium-3.5-128b',
  quick_posts_provider:     'gemini', quick_posts_model:     'gemini-2.5-flash',
};

/** Resolves every setting as key → value: saved row, then env var, then hardcoded default. */
export async function getSettings(): Promise<Record<SettingKey, string>> {
  const { data, error } = await supabase.from('app_settings').select('key,value');
  if (error) console.error('[Settings] Failed to load app_settings, using env/defaults only:', error.message);

  const saved = new Map((data || []).map(r => [r.key as SettingKey, r.value as string | null]));
  const out = {} as Record<SettingKey, string>;
  for (const key of Object.keys(HARDCODED_DEFAULTS) as SettingKey[]) {
    out[key] = saved.get(key) || ENV_FALLBACK[key] || HARDCODED_DEFAULTS[key];
  }
  return out;
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Failed to save setting "${key}": ${error.message}`);
}

/** Provider + model + the right API key for a given pipeline stage, resolved in one call. */
export async function getStageConfig(
  stage: 'analysis' | 'podcast' | 'social_scripts' | 'youtube_concept' | 'quick_posts',
): Promise<{ provider: Provider; model: string; apiKey: string }> {
  const s = await getSettings();
  const provider = s[`${stage}_provider` as SettingKey] as Provider;
  const model = s[`${stage}_model` as SettingKey];
  const apiKey = s[`${provider}_api_key` as SettingKey] || '';
  return { provider, model, apiKey };
}
