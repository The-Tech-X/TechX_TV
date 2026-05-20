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

/** Fetch the topic rows referenced by an episode's analysis_json.topic_ids. */
export async function getTopicsForEpisodeRetry(episodeWeekId: string) {
  const { data: ep, error: epErr } = await supabase
    .from('episodes')
    .select('analysis_json')
    .eq('week_id', episodeWeekId)
    .single();
  if (epErr || !ep) {
    console.error("Error fetching episode for retry:", epErr);
    return { topics: [] as any[], language: 'english' as const };
  }
  const topicIds: string[] = Array.isArray(ep.analysis_json?.topic_ids) ? ep.analysis_json.topic_ids : [];
  const language: 'english' | 'tenglish' =
    ep.analysis_json?.language === 'tenglish' ? 'tenglish' : 'english';
  if (!topicIds.length) return { topics: [], language };

  const { data: topics, error: tErr } = await supabase
    .from('updates')
    .select('*')
    .in('id', topicIds);
  if (tErr) {
    console.error("Error fetching topics for retry:", tErr);
    return { topics: [], language };
  }
  return { topics: topics || [], language };
}
