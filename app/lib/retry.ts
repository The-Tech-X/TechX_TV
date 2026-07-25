// Shared by app/api/analyze/route.ts (NIM podcast script call) and
// app/api/analytics/route.ts (Firecrawl + Mistral calls) — both hit
// flaky upstream APIs and need the same "retry transient failures,
// don't retry real ones" policy.

// We allow 4 attempts total — initial + 3 retries with backoff (5s, 15s, 45s).
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

// Errors that mean "try again, the network or the upstream blinked" — NOT
// errors that mean "the request itself is bad and would keep failing".
const TRANSIENT_ERROR_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

export function isTransientError(err: any): boolean {
  if (!err) return false;
  const code = err.code || err.cause?.code;
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
  if (err.name === 'AbortError') return true;
  // Upstream sometimes returns an empty/partial body — res.json() throws a
  // SyntaxError with no .code, so it wasn't being retried. Treat it as transient.
  if (err instanceof SyntaxError && err.message.toLowerCase().includes('json')) return true;
  return false;
}
