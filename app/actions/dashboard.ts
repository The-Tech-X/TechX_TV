"use server";

import { createClient } from '@supabase/supabase-js';
import { currentWeekId } from '../lib/weekId';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export type DashboardTopic = {
  id: string;
  title: string;
  source: string | null;
  status: string;
  social_score: number | null;
  recommended_platform: string | null;
  episode_id: string | null;
  analysis_json: unknown;
  week_id: string | null;
  created_at: string;
  /** platform keys with a 'done' social_scripts row: any of 'instagram'|'youtube'|'linkedin'|'whatsapp'|'x' */
  platforms: string[];
};

export async function getDashboardTopics(scope: 'week' | 'all' = 'week'): Promise<DashboardTopic[]> {
  let query = supabase
    .from('updates')
    .select('id,title,source,status,social_score,recommended_platform,episode_id,analysis_json,week_id,created_at')
    .order('social_score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (scope === 'week') {
    query = query.eq('week_id', currentWeekId());
  }

  const { data: updates, error } = await query;
  if (error) {
    console.error('[Dashboard] getDashboardTopics error:', error);
    return [];
  }
  if (!updates || updates.length === 0) return [];

  const ids = updates.map((u) => u.id);
  const { data: scripts, error: scriptsErr } = await supabase
    .from('social_scripts')
    .select('update_id, platform')
    .in('update_id', ids)
    .eq('status', 'done');
  if (scriptsErr) console.error('[Dashboard] social_scripts fetch error:', scriptsErr);

  const platformsByUpdate = new Map<string, string[]>();
  for (const row of scripts || []) {
    if (!row.update_id) continue;
    const list = platformsByUpdate.get(row.update_id) ?? [];
    list.push(row.platform);
    platformsByUpdate.set(row.update_id, list);
  }

  return updates.map((u) => ({
    ...u,
    platforms: platformsByUpdate.get(u.id) ?? [],
  })) as DashboardTopic[];
}
