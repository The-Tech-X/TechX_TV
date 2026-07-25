"use server";

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
);

export async function getScoredUpdates() {
  const { data, error } = await supabase
    .from("updates")
    .select(
      "id,title,source,social_score,recommended_platform,social_reasoning,platform_override,analysis_json,week_id,created_at",
    )
    .not("social_score", "is", null)
    .order("social_score", { ascending: false });

  if (error) {
    console.error("[Social] getScoredUpdates error:", error);
    return [];
  }
  return data || [];
}

export async function saveOverride(
  id: string,
  override: "instagram" | "youtube" | "none",
) {
  const { error } = await supabase
    .from("updates")
    .update({ platform_override: override })
    .eq("id", id);
  if (error) throw new Error("Failed to save override: " + error.message);
}

export async function getAllAnalyzedUpdateIds(): Promise<string[]> {
  const { data, error } = await supabase
    .from("updates")
    .select("id")
    .not("analysis_json", "is", null);
  if (error) return [];
  return (data || []).map((u: any) => u.id);
}

/** All generated platform content for one topic — used by the per-topic
 * workspace (/topics/[id]) to pre-fill Quick Post / Reel / Video cards with
 * whatever's already been generated, instead of starting blank every visit. */
export async function getSocialScriptsForUpdate(updateId: string) {
  const { data, error } = await supabase
    .from("social_scripts")
    .select("platform, script_json, note, updated_at")
    .eq("update_id", updateId)
    .eq("status", "done");

  if (error) {
    console.error("[Social] getSocialScriptsForUpdate error:", error);
    return [];
  }
  return data || [];
}

export async function getYoutubeConcepts() {
  const { data, error } = await supabase
    .from("youtube_concepts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("[Social] getYoutubeConcepts error:", error);
    return [];
  }
  return data || [];
}
