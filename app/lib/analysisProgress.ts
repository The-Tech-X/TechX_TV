export type AnalysisProgress = {
  step: "searching" | "analyzing" | "failed";
  query?: string;
  sources?: { title: string; url: string }[];
  error?: string;
  retrying?: boolean;
  attempt?: number;
  totalAttempts?: number;
  updated_at?: string;
} | null;

/** Human-readable line for the in-flight analysis_progress written by /api/analytics. */
export function progressStepText(p: AnalysisProgress): string {
  if (!p) return "Searching the web and writing the research brief — can take a few minutes.";
  if (p.step === "searching") {
    return p.retrying
      ? `Web search hit a snag — retrying (attempt ${p.attempt}/${p.totalAttempts})…`
      : "Searching the web for context…";
  }
  if (p.step === "analyzing") {
    return p.retrying
      ? `Writing the brief hit a snag — retrying (attempt ${p.attempt}/${p.totalAttempts})…`
      : "Found sources — writing the brief…";
  }
  if (p.step === "failed") return "Analysis failed.";
  return "Analyzing…";
}
