/**
 * Derived per-episode status. We don't have a status column on `episodes`, so
 * we infer from existing fields the analyze route already writes:
 *   - script_text present                          → 'ready'
 *   - analysis_json.error / status === 'failed'    → 'failed'
 *   - analysis_json.status === 'generating'        → 'generating'
 *   - otherwise                                    → 'pending'
 */
export type EpisodeStatus = 'ready' | 'generating' | 'failed' | 'pending';

export function episodeStatus(ep: any): EpisodeStatus {
  if (ep?.script_text) return 'ready';
  const a = ep?.analysis_json;
  if (a?.error || a?.status === 'failed') return 'failed';
  if (a?.status === 'generating') return 'generating';
  return 'pending';
}

export function episodeStatusLabel(s: EpisodeStatus): string {
  switch (s) {
    case 'ready':      return 'Ready';
    case 'generating': return 'Generating…';
    case 'failed':     return 'Failed';
    case 'pending':    return 'No script';
  }
}
