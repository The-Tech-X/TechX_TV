"use server";

import { getSettings, setSetting, type SettingKey, type Provider } from "../lib/settings";
import { callChatModel } from "../lib/aiProvider";

function maskKey(v: string): string {
  if (!v) return "";
  return v.length <= 4 ? "••••" : `••••${v.slice(-4)}`;
}

export type SettingsForUI = {
  nvidia_api_key_masked: string;
  openai_api_key_masked: string;
  gemini_api_key_masked: string;
  claude_api_key_masked: string;
  firecrawl_api_key_masked: string;

  analysis_provider: Provider;        analysis_model: string;
  podcast_provider: Provider;         podcast_model: string;
  social_scripts_provider: Provider;  social_scripts_model: string;
  youtube_concept_provider: Provider; youtube_concept_model: string;
  quick_posts_provider: Provider;     quick_posts_model: string;
};

/** API keys are never sent to the client in full — only a masked hint (last
 * 4 chars) so the Settings page can show "a key is saved" without exposing
 * it. Providers/models aren't secret, so those come through as-is. */
export async function getSettingsForUI(): Promise<SettingsForUI> {
  const s = await getSettings();
  return {
    nvidia_api_key_masked:    maskKey(s.nvidia_api_key),
    openai_api_key_masked:    maskKey(s.openai_api_key),
    gemini_api_key_masked:    maskKey(s.gemini_api_key),
    claude_api_key_masked:    maskKey(s.claude_api_key),
    firecrawl_api_key_masked: maskKey(s.firecrawl_api_key),

    analysis_provider:        s.analysis_provider as Provider,        analysis_model:        s.analysis_model,
    podcast_provider:         s.podcast_provider as Provider,         podcast_model:         s.podcast_model,
    social_scripts_provider:  s.social_scripts_provider as Provider,  social_scripts_model:  s.social_scripts_model,
    youtube_concept_provider: s.youtube_concept_provider as Provider, youtube_concept_model: s.youtube_concept_model,
    quick_posts_provider:     s.quick_posts_provider as Provider,     quick_posts_model:     s.quick_posts_model,
  };
}

/** Blank submit = leave the existing saved value untouched (never overwrite
 * a real key with an empty string just because the field was left blank). */
export async function saveSetting(key: SettingKey, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) return;
  await setSetting(key, trimmed);
}

/** One small live round-trip to confirm a provider + model actually work
 * together, using whichever API key is currently saved for that provider —
 * exactly the combination that would be used in production. This is the
 * safety net against silent breakage like the mistral-large-3 retirement. */
export async function testModel(provider: Provider, model: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const started = Date.now();
  const s = await getSettings();
  const apiKey = s[`${provider}_api_key` as SettingKey] || "";

  if (!apiKey) {
    return { ok: false, message: `No ${provider} API key saved yet — save one above first.`, latencyMs: 0 };
  }
  if (!model.trim()) {
    return { ok: false, message: "Enter a model name first.", latencyMs: 0 };
  }

  try {
    const text = await callChatModel({
      provider,
      apiKey,
      model: model.trim(),
      systemPrompt: "Reply with exactly one word.",
      userPrompt: "Reply with exactly one word: OK",
      maxTokens: 20,
      temperature: 0,
    });
    return {
      ok: true,
      message: text.trim() ? `Responded: "${text.trim().slice(0, 80)}"` : "Responded (empty text, but the call succeeded).",
      latencyMs: Date.now() - started,
    };
  } catch (e: any) {
    return { ok: false, message: e?.message || "Test failed", latencyMs: Date.now() - started };
  }
}
