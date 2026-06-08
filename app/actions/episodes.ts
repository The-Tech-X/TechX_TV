"use server";

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export async function getEpisodes() {
  const { data, error } = await supabase
    .from('episodes')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error("Error fetching episodes:", error);
    return [];
  }
  return data || [];
}

export async function updateEpisodeScript(id: string, script_text: string) {
  const { data, error } = await supabase
    .from('episodes')
    .update({ script_text })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error("Error updating script:", error);
    throw new Error("Failed to update script");
  }
  return data;
}

/**
 * Reset an episode back to pending: clears script_text, resets analysis_json
 * status to 'pending', and unlinks all associated updates (sets their
 * episode_id back to null and status back to 'selected').
 */
export async function resetEpisode(episodeWeekId: string) {
  // 1. Fetch the episode row to get its UUID and linked topic_ids
  const { data: ep, error: epErr } = await supabase
    .from('episodes')
    .select('id, analysis_json')
    .eq('week_id', episodeWeekId)
    .single();
  if (epErr || !ep) throw new Error('Episode not found: ' + episodeWeekId);

  // 2a. Unlink updates by episode_id (set by the callback after script generation)
  const { error: unlinkByEpErr } = await supabase
    .from('updates')
    .update({ episode_id: null, status: 'selected' })
    .eq('episode_id', ep.id);
  if (unlinkByEpErr) throw new Error('Failed to unlink updates by episode_id: ' + unlinkByEpErr.message);

  // 2b. Also reset by topic_ids stored in analysis_json — catches any rows that
  //     were linked but whose episode_id may not have been set (e.g. QStash path).
  const topicIds: string[] = Array.isArray(ep.analysis_json?.topic_ids)
    ? ep.analysis_json.topic_ids
    : [];
  if (topicIds.length) {
    const { error: unlinkByIdsErr } = await supabase
      .from('updates')
      .update({ episode_id: null, status: 'selected' })
      .in('id', topicIds);
    if (unlinkByIdsErr) throw new Error('Failed to unlink updates by topic_ids: ' + unlinkByIdsErr.message);
  }

  // 3. Clear the episode script and reset status
  const existingMeta = ep.analysis_json || {};
  const { data, error: resetErr } = await supabase
    .from('episodes')
    .update({
      script_text: null,
      analysis_json: { ...existingMeta, status: 'pending' },
      updated_at: new Date().toISOString(),
    })
    .eq('week_id', episodeWeekId)
    .select()
    .single();
  if (resetErr) throw new Error('Failed to reset episode: ' + resetErr.message);
  return data;
}

/** Fetch the topic rows referenced by an episode's analysis_json.topic_ids. */
export async function getTopicsForEpisodeRetry(episodeWeekId: string) {
  const { data: ep, error: epErr } = await supabase
    .from('episodes')
    .select('analysis_json')
    .eq('week_id', episodeWeekId)
    .single();
  if (epErr || !ep) {
    console.error("Error fetching episode for retry:", epErr);
    return { topics: [] as any[] };
  }
  const topicIds: string[] = Array.isArray(ep.analysis_json?.topic_ids) ? ep.analysis_json.topic_ids : [];
  if (!topicIds.length) return { topics: [] };

  const { data: topics, error: tErr } = await supabase
    .from('updates')
    .select('*')
    .in('id', topicIds);
  if (tErr) {
    console.error("Error fetching topics for retry:", tErr);
    return { topics: [] };
  }
  return { topics: topics || [] };
}
