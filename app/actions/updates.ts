"use server";

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export async function getUpdates() {
  try {
    const { data, error } = await supabase
      .from('updates')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error("Error fetching updates:", error);
    return [];
  }
}

export async function saveUpdate(topicData: {
  title: string;
  url?: string;
  source: string;
  content: string;
  status: string;
}) {
  try {
    const { data, error } = await supabase
      .from('updates')
      .insert([topicData])
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.error("Error saving update:", error);
    throw new Error("Failed to save topic");
  }
}

export async function toggleUpdateStatus(id: string, newStatus: string) {
  try {
    const { data, error } = await supabase
      .from('updates')
      .update({ status: newStatus })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.error("Error toggling status:", error);
    throw new Error("Failed to update status");
  }
}

/** Link a batch of updates to an episode after analysis completes */
export async function linkUpdatesToEpisode(topicIds: string[], episodeId: string) {
  if (!topicIds.length || !episodeId) return;
  const { error } = await supabase
    .from('updates')
    .update({ episode_id: episodeId, status: 'done' })
    .in('id', topicIds);
  if (error) console.error("Error linking updates to episode:", error);
}

/** Get all updates linked to a specific episode */
export async function getUpdatesByEpisode(episodeId: string) {
  const { data, error } = await supabase
    .from('updates')
    .select('*')
    .eq('episode_id', episodeId)
    .order('created_at', { ascending: true });
  if (error) console.error("Error fetching episode updates:", error);
  return data || [];
}

/** Delete a topic */
export async function deleteUpdate(id: string) {
  const { error } = await supabase
    .from('updates')
    .delete()
    .eq('id', id);
  if (error) throw new Error("Failed to delete topic");
}

/** Shape we store in updates.analysis_json. All fields are user-editable. */
export type TopicAnalysis = {
  summary: string;
  whyNow: string;
  keyFacts: string[];
  biggerPicture: string;
  honestTake: string;
  sources?: { title: string; url: string }[];
};

/** Persist edits to a single topic's analysis. */
export async function updateTopicAnalysis(id: string, analysis: TopicAnalysis) {
  const { data, error } = await supabase
    .from('updates')
    .update({ analysis_json: analysis })
    .eq('id', id)
    .select()
    .single();
  if (error) {
    console.error("Error saving topic analysis:", error);
    throw new Error("Failed to save analysis");
  }
  return data;
}

/** Fetch the topics the user has currently selected (status='selected'), oldest first. */
export async function getSelectedUpdates() {
  const { data, error } = await supabase
    .from('updates')
    .select('*')
    .eq('status', 'selected')
    .order('created_at', { ascending: true });
  if (error) {
    console.error("Error fetching selected updates:", error);
    return [];
  }
  return data || [];
}

/**
 * Topics the Analytics page can offer for the next episode: anything the user
 * has currently selected, plus anything previously analyzed (analysis_json set)
 * that hasn't yet been linked to a finished script (status != 'done'). Lets the
 * user reuse work from earlier sessions without going back to Topic Discovery.
 */
export async function getAnalyzableUpdates() {
  const { data, error } = await supabase
    .from('updates')
    .select('*')
    .neq('status', 'done')
    .order('created_at', { ascending: true });
  if (error) {
    console.error("Error fetching analyzable updates:", error);
    return [];
  }
  // Keep currently-selected topics (which may not yet have an analysis) plus
  // any previously-analyzed pending ones. Drop bare pending topics with no
  // analysis — those still belong on Topic Discovery, not here.
  return (data || []).filter(t => t.status === 'selected' || t.analysis_json);
}
