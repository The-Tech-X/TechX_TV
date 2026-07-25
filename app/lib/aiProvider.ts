import { Agent } from 'undici';
import type { Provider } from './settings';

// Same reasoning as the original per-route dispatchers this replaces: undici's
// default ~5-minute headers/body timeout can kill a slow provider response
// before our own retry/watchdog logic (in the calling route) ever gets a
// chance to time it out on purpose. Applied uniformly to every provider —
// harmless for fast ones, necessary for NIM's more variable latency.
const CALL_TIMEOUT_MS = 10 * 60 * 1000;
export const dispatcher = new Agent({
  headersTimeout:   CALL_TIMEOUT_MS,
  bodyTimeout:      CALL_TIMEOUT_MS,
  connectTimeout:   30_000,
  keepAliveTimeout: 60_000,
});

export type ChatArgs = {
  provider: Provider;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  // Gemini 2.5+'s internal "thinking" tokens draw from the same maxOutputTokens
  // budget as the visible output — confirmed via testing that this can consume
  // hundreds of tokens regardless of task complexity, truncating short-output
  // stages (e.g. quick_posts' 600-1000 token budgets) before any real content
  // is written. Set true for stages that don't need deep reasoning; leave
  // false for stages where more thinking may genuinely help (analysis, etc).
  // No-op for non-Gemini providers.
  disableThinking?: boolean;
};

/** Builds the {url, headers, body} for whichever provider is configured,
 * without actually making the call. Exists alongside callChatModel (below)
 * because some callers — e.g. app/api/analyze/route.ts's QStash queue path —
 * need to hand the raw request to something else (a queue service) rather
 * than fetch it themselves. */
export function buildProviderRequest(
  args: Omit<ChatArgs, 'signal'>,
): { url: string; headers: Record<string, string>; body: any } {
  const { provider, apiKey, model, systemPrompt, userPrompt, maxTokens, temperature, disableThinking } = args;

  switch (provider) {
    case 'nvidia':
    case 'openai':
      return {
        url: provider === 'nvidia'
          ? 'https://integrate.api.nvidia.com/v1/chat/completions'
          : 'https://api.openai.com/v1/chat/completions',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
          temperature: temperature ?? 0.6,
          max_tokens: maxTokens,
        },
      };

    case 'gemini':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
        headers: { 'Content-Type': 'application/json' },
        body: {
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: temperature ?? 0.7,
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json',
            ...(disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        },
      };

    case 'claude':
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: {
          model,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          max_tokens: maxTokens,
          temperature: temperature ?? 0.7,
        },
      };

    default:
      throw new Error(`Unknown provider "${provider}"`);
  }
}

/** Pulls the plain-text completion out of a provider's raw JSON response body.
 * Each provider shapes this differently (OpenAI-style choices[], Gemini
 * candidates[], Claude content[] blocks) — kept in one place so every caller
 * (direct calls here, and analyze/route.ts's self-callback which receives
 * the same raw body asynchronously) parses each provider identically. */
export function extractRawText(provider: Provider, data: any): string {
  switch (provider) {
    case 'nvidia':
    case 'openai': {
      const raw: string = data.choices?.[0]?.message?.content ?? '';
      return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    }
    case 'gemini':
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    case 'claude':
      return (data.content || []).map((b: any) => b.text || '').join('').trim();
    default:
      return '';
  }
}

/** Calls whichever provider is configured and returns the raw text response.
 * Callers are responsible for parsing JSON out of it via parseModelJson —
 * providers vary in how reliably they stick to "JSON only", so parsing is
 * kept uniform rather than trusting each API's own structured-output mode. */
export async function callChatModel(args: ChatArgs): Promise<string> {
  if (!args.apiKey) {
    throw new Error(`No API key saved for provider "${args.provider}" — add one in Settings.`);
  }
  if (!args.model.trim()) {
    throw new Error(`No model set for this stage — add one in Settings.`);
  }

  const { url, headers, body } = buildProviderRequest(args);
  const res = await fetch(url, {
    method: 'POST',
    // Confirmed via direct testing: a manually-constructed undici Agent (used
    // here for the long-timeout dispatcher) does not auto-decompress gzip
    // responses the way undici's default dispatcher does — Google's API gzips
    // its response regardless, so without this we'd get raw gzip bytes handed
    // to res.json() and a cryptic "not valid JSON" error. Asking for no
    // compression sidesteps the whole issue.
    headers: { ...headers, 'Accept-Encoding': 'identity' },
    body: JSON.stringify(body),
    signal: args.signal,
    // @ts-expect-error — undici dispatcher option, not in stock fetch types
    dispatcher,
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`${args.provider} ${res.status}: ${(data.error?.message || JSON.stringify(data)).slice(0, 300)}`);
  }

  const raw = extractRawText(args.provider, data);
  if (!raw) {
    const finishReason = data.candidates?.[0]?.finishReason;
    throw new Error(`${args.provider} returned no content${finishReason ? ` (finishReason: ${finishReason})` : ''}`);
  }
  return raw;
}

/** Best-effort "why did generation stop" signal, used only for diagnostics /
 * recovery-note wording — each provider names this differently, and it's
 * fine if a provider we don't special-case here returns undefined. */
export function extractFinishReason(provider: Provider, data: any): string | undefined {
  switch (provider) {
    case 'nvidia':
    case 'openai':
      return data.choices?.[0]?.finish_reason;
    case 'gemini':
      return data.candidates?.[0]?.finishReason;
    case 'claude':
      return data.stop_reason;
    default:
      return undefined;
  }
}

/** Extracts a JSON object/array from a model's raw text response. Models
 * vary in how strictly they follow "return only JSON" — this strips
 * <think> tags and ``` fences, then falls back to regex-extracting the
 * outermost {...} or [...] if the response isn't already clean JSON. */
export function parseModelJson(raw: string): any {
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to regex extraction below
  }

  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  const candidate =
    objMatch && (!arrMatch || (objMatch.index ?? 0) <= (arrMatch.index ?? 0)) ? objMatch[0]
    : arrMatch ? arrMatch[0]
    : cleaned;

  return JSON.parse(candidate);
}
