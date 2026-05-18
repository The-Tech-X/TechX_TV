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
