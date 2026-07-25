"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getUpdates, getUpdateById, saveUpdate, toggleUpdateStatus } from "../actions/updates";
import { Link2, Plus, Zap, Loader2, X, CheckCircle2, Circle, ExternalLink, ChevronRight, Brain, Trash2, RefreshCw } from "lucide-react";
import { deleteUpdate } from "../actions/updates";
import { progressStepText, type AnalysisProgress } from "../lib/analysisProgress";

// Fire-and-forget: kick off the research brief the moment a topic is saved,
// no selection or manual "Run Analytics" step needed. skipScoring is true
// because there's nothing yet to compare a single new topic against —
// cross-topic Reel/Video scoring happens separately, by date range, on the
// Analytics page. `onSettled` fires only on a genuine server-reported
// outcome (success or a real analysis error) — this is the actual signal to
// refresh the UI, since the request itself never gets awaited by the caller.
//
// A network-level failure here (the browser's connection to our own
// /api/analytics dropped — e.g. "TypeError: Failed to fetch") is NOT the
// same thing as the analysis failing: the route keeps running server-side
// regardless of whether the client is still listening. Deliberately don't
// call onSettled in that case — the progress poller in the page component
// independently discovers the real outcome (success or a persisted
// failure) once the server finishes, instead of us guessing "failed" here.
function triggerAutoAnalysis(topicId: string, onSettled: (topicId: string, error?: string) => void) {
  fetch("/api/analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topicIds: [topicId], skipScoring: true }),
  })
    .then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onSettled(topicId, data.error || `Analysis failed (${res.status})`); return; }
      const result = data.results?.[0];
      if (result?.error) { onSettled(topicId, result.error); return; }
      onSettled(topicId);
    })
    .catch((err: any) => {
      console.warn(
        "[Discover] Connection to /api/analytics dropped for topic", topicId,
        "— relying on progress polling to find the real outcome.", err,
      );
    });
}

export default function TopicDiscoveryPage() {
  const router = useRouter();
  const [updates, setUpdates] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newUrl, setNewUrl] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [isScraping, setIsScraping] = useState(false);
  const [selectedTopicDetails, setSelectedTopicDetails] = useState<any | null>(null);
  const [activeTab, setActiveTab] = useState<"active" | "done">("active");
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set());
  const [analysisErrors, setAnalysisErrors] = useState<Record<string, string>>({});
  const [progressMap, setProgressMap] = useState<Record<string, AnalysisProgress>>({});

  useEffect(() => { loadData(); }, []);

  // Live progress + settlement: while any topics are analyzing, poll their
  // analysis_progress/analysis_json directly from the DB. This is the
  // single source of truth for whether a topic is actually done or failed —
  // independent of whether the fetch that kicked it off is still connected.
  // That matters because a dropped client connection ("Failed to fetch")
  // does NOT stop the server-side work, so relying on the triggering fetch
  // alone to decide success/failure would show false failures.
  useEffect(() => {
    if (analyzingIds.size === 0) return;
    let cancelled = false;
    const poll = async () => {
      const ids = Array.from(analyzingIds);
      let rows: any[];
      try {
        rows = await Promise.all(ids.map(id => getUpdateById(id)));
      } catch (e) {
        console.warn("[Discover] Progress poll failed, will retry", e);
        return;
      }
      if (cancelled) return;
      setProgressMap(prev => {
        const next = { ...prev };
        for (const t of rows) if (t) next[t.id] = t.analysis_progress || null;
        return next;
      });
      for (const t of rows) {
        if (!t) continue;
        if (t.analysis_json) {
          setAnalyzingIds(prev => { const next = new Set(prev); next.delete(t.id); return next; });
          setProgressMap(prev => { const { [t.id]: _omit, ...rest } = prev; return rest; });
          setAnalysisErrors(prev => { const { [t.id]: _omit, ...rest } = prev; return rest; });
          loadData();
        } else if (t.analysis_progress?.step === "failed") {
          setAnalyzingIds(prev => { const next = new Set(prev); next.delete(t.id); return next; });
          setAnalysisErrors(prev => ({ ...prev, [t.id]: t.analysis_progress.error || "Analysis failed" }));
        }
      }
    };
    poll();
    const interval = setInterval(poll, 2500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [analyzingIds]);

  async function loadData() {
    setIsLoading(true);
    setUpdates(await getUpdates());
    setIsLoading(false);
  }

  const startAutoAnalysis = (topicId: string) => {
    setAnalyzingIds(prev => new Set(prev).add(topicId));
    triggerAutoAnalysis(topicId, (id, error) => {
      setAnalyzingIds(prev => { const next = new Set(prev); next.delete(id); return next; });
      setProgressMap(prev => { const { [id]: _omit, ...rest } = prev; return rest; });
      if (error) {
        setAnalysisErrors(prev => ({ ...prev, [id]: error }));
      } else {
        setAnalysisErrors(prev => { const { [id]: _omit, ...rest } = prev; return rest; });
        loadData(); // refresh so the "Analyzed" badge actually reflects the finished brief
      }
    });
  };

  const filteredUpdates = updates.filter(u =>
    activeTab === "active" ? u.status !== "done" : u.status === "done"
  );
  const selectedCount = updates.filter(u => u.status === "selected").length;

  const handleSelect = async (id: string, current: string) => {
    const next = current === "selected" ? "pending" : "selected";
    setUpdates(prev => prev.map(u => u.id === id ? { ...u, status: next } : u));
    try { await toggleUpdateStatus(id, next); }
    catch { setUpdates(prev => prev.map(u => u.id === id ? { ...u, status: current } : u)); }
  };

  const handleDelete = async (id: string) => {
    setUpdates(prev => prev.filter(u => u.id !== id));
    try { await deleteUpdate(id); }
    catch { await loadData(); }
  };

  const handleAddTopic = async () => {
    if (!newUrl.trim()) return;

    if (!newUrl.startsWith("http://") && !newUrl.startsWith("https://")) {
      const saved = await saveUpdate({
        title: newUrl,
        source: "Manual Entry",
        status: "selected",
        content: manualDescription || "No description provided.",
      });
      setUpdates(prev => [saved, ...prev]);
      startAutoAnalysis(saved.id);
      setNewUrl(""); setManualDescription("");
      return;
    }

    setIsScraping(true);
    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: newUrl }),
      });
      if (!res.ok) throw new Error("Scrape failed");
      const data = await res.json();
      const saved = await saveUpdate({ title: data.title, source: data.source, url: data.url, status: "selected", content: data.content });
      setUpdates(prev => [saved, ...prev]);
      startAutoAnalysis(saved.id);
      setNewUrl(""); setManualDescription("");
    } catch {
      const saved = await saveUpdate({ title: newUrl, source: "Manual (fallback)", status: "selected", content: manualDescription || "" });
      setUpdates(prev => [saved, ...prev]);
      startAutoAnalysis(saved.id);
      setNewUrl(""); setManualDescription("");
    } finally {
      setIsScraping(false);
    }
  };

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-up">
      {/* Page header */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-black">Topic Discovery</h1>
          <p className="text-neutral-500 text-xs sm:text-sm mt-1">Add news articles — each one gets a research brief automatically. Select which ones make this week's cut.</p>
        </div>

        {/* Analytics link */}
        <div className="flex items-center gap-2 bg-white border border-black/[0.10] rounded-2xl p-2 shadow-xl w-full lg:w-auto lg:shrink-0">
          {selectedCount > 0 && (
            <span className="text-[11px] sm:text-xs font-semibold text-red-600 bg-red-500/10 px-2.5 py-1.5 rounded-lg whitespace-nowrap border border-red-500/15">
              {selectedCount} selected
            </span>
          )}
          <button
            onClick={() => router.push("/analytics")}
            title="Review research briefs and score topics"
            className="flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-500 text-white text-sm px-4 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-red-500/20 whitespace-nowrap ml-auto"
          >
            <Brain className="w-3.5 h-3.5" />
            View Analytics
          </button>
        </div>
      </div>

      {/* Add topic */}
      <div className="bg-white border border-black/[0.08] rounded-2xl p-4 sm:p-5 card-glow">
        <h2 className="text-sm font-semibold text-neutral-800 mb-3 sm:mb-4 flex items-center gap-2">
          <Plus className="w-4 h-4 text-red-600" />
          Add Topic or URL
        </h2>
        <div className="space-y-3">
          <div className="flex items-center gap-2 sm:gap-3 bg-[#f5f5f5] border border-black/[0.08] rounded-xl px-3 sm:px-4 focus-within:border-red-500/40 transition-colors">
            <Link2 className="w-4 h-4 text-neutral-400 shrink-0" />
            <input
              type="text"
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAddTopic()}
              placeholder="Paste a URL or type a topic title..."
              className="flex-1 min-w-0 bg-transparent py-3 text-sm text-neutral-900 placeholder-neutral-400 outline-none"
            />
            {newUrl && (
              <button onClick={() => setNewUrl("")} className="text-neutral-400 hover:text-neutral-600 p-1 -mr-1">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <textarea
              value={manualDescription}
              onChange={e => setManualDescription(e.target.value)}
              placeholder="Optional: paste article content or description for better AI analysis..."
              rows={2}
              className="flex-1 bg-[#f5f5f5] border border-black/[0.08] rounded-xl px-4 py-3 text-sm text-neutral-900 placeholder-neutral-400 outline-none resize-none focus:border-red-500/40 transition-colors"
            />
            <button
              onClick={handleAddTopic}
              disabled={isScraping || !newUrl.trim()}
              className="flex sm:flex-col items-center justify-center gap-2 sm:gap-1 bg-black/[0.04] hover:bg-black/[0.08] active:bg-black/[0.12] disabled:opacity-40 text-neutral-800 hover:text-black px-5 py-3 sm:py-0 rounded-xl border border-black/[0.08] sm:min-w-[80px] transition-all"
            >
              {isScraping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              <span className="text-xs font-medium">{isScraping ? "Fetching..." : "Add Topic"}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Topics list */}
      <div className="bg-white border border-black/[0.08] rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-3 sm:px-5 py-3 sm:py-3.5 border-b border-black/[0.08] bg-black/[0.01]">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <div className="flex items-center gap-1 bg-[#f5f5f5] p-1 rounded-xl border border-black/[0.08]">
              {(["active", "done"] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 sm:px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all capitalize ${
                    activeTab === tab ? "bg-red-600 text-white shadow-lg shadow-red-500/20" : "text-neutral-500 hover:text-neutral-800"
                  }`}
                >
                  {tab === "active" ? "Active" : "Done"}
                  <span className={`ml-1.5 tabular-nums ${activeTab === tab ? "opacity-80" : "opacity-40"}`}>
                    {updates.filter(u => tab === "active" ? u.status !== "done" : u.status === "done").length}
                  </span>
                </button>
              ))}
            </div>
            {selectedCount > 0 && activeTab === "active" && (
              <span className="hidden sm:inline text-xs text-neutral-500">
                {selectedCount} of {updates.filter(u => u.status !== "done").length} selected
              </span>
            )}
          </div>
          <button
            onClick={loadData}
            aria-label="Refresh"
            className="p-2 rounded-lg hover:bg-black/[0.05] active:bg-black/[0.08] text-neutral-400 hover:text-neutral-600 transition-colors shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="divide-y divide-black/[0.06]">
          {filteredUpdates.length === 0 && !isLoading && (
            <div className="py-16 text-center">
              <div className="w-12 h-12 rounded-2xl bg-black/[0.03] border border-black/[0.08] flex items-center justify-center mx-auto mb-3">
                <Zap className="w-5 h-5 text-neutral-300" />
              </div>
              <p className="text-neutral-500 text-sm">
                {activeTab === "active" ? "No topics yet. Add one above to get started!" : "No processed topics yet."}
              </p>
            </div>
          )}
          {isLoading && (
            <div className="py-10 flex justify-center">
              <Loader2 className="w-5 h-5 text-neutral-400 animate-spin" />
            </div>
          )}
          {filteredUpdates.map((update, i) => (
            <div
              key={update.id}
              className="flex items-center gap-3 sm:gap-4 px-3 sm:px-5 py-3 sm:py-3.5 hover:bg-black/[0.02] active:bg-black/[0.03] transition-colors group animate-fade-up"
              style={{ animationDelay: `${i * 25}ms` }}
            >
              {/* Select toggle — only on active */}
              {activeTab === "active" ? (
                <button
                  onClick={() => handleSelect(update.id, update.status)}
                  aria-label={update.status === "selected" ? "Deselect topic" : "Select topic"}
                  className="shrink-0 p-1 -m-1 hover:scale-110 transition-transform"
                >
                  {update.status === "selected"
                    ? <CheckCircle2 className="w-5 h-5 text-red-600" />
                    : <Circle className="w-5 h-5 text-neutral-300 hover:text-neutral-500" />
                  }
                </button>
              ) : (
                <CheckCircle2 className="w-5 h-5 text-emerald-500/60 shrink-0" />
              )}

              {/* Title + source */}
              <div
                className="flex-1 min-w-0 cursor-pointer py-0.5"
                onClick={() => setSelectedTopicDetails(update)}
              >
                <p className={`text-sm font-medium leading-snug line-clamp-2 sm:truncate transition-colors group-hover:text-red-600 ${
                  update.status === "selected" ? "text-black" : "text-neutral-800"
                }`}>
                  {update.title}
                </p>
                <p className="text-[11px] sm:text-xs text-neutral-400 mt-0.5 truncate">{update.source}</p>
              </div>

              {/* Right side badges + actions */}
              <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                {update.episode_id && (
                  <span className="hidden sm:inline text-[10px] text-neutral-400 bg-black/[0.04] px-2 py-0.5 rounded border border-black/[0.07]">
                    linked
                  </span>
                )}
                {analyzingIds.has(update.id) && (
                  <span
                    title={[
                      progressStepText(progressMap[update.id] ?? null),
                      ...(progressMap[update.id]?.sources?.map(s => s.title || s.url) ?? []),
                    ].join("\n")}
                    className="px-1.5 sm:px-2 py-0.5 rounded-md bg-red-500/10 text-red-600 text-[10px] sm:text-[11px] font-semibold border border-red-500/20 flex items-center gap-1"
                  >
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    Analyzing…
                  </span>
                )}
                {analysisErrors[update.id] && (
                  <span
                    title={analysisErrors[update.id]}
                    className="px-1.5 sm:px-2 py-0.5 rounded-md bg-red-500/10 text-red-600 text-[10px] sm:text-[11px] font-semibold border border-red-500/20 flex items-center gap-1"
                  >
                    Analysis failed
                  </span>
                )}
                {update.analysis_json && update.status !== "done" && (
                  <span
                    title="A research brief has been generated for this topic — it can be sent straight to the script writer from Analytics."
                    className="px-1.5 sm:px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 text-[10px] sm:text-[11px] font-semibold border border-emerald-500/20 flex items-center gap-1"
                  >
                    <Brain className="w-2.5 h-2.5" />
                    Analyzed
                  </span>
                )}
                {update.status === "selected" && (
                  <span className="px-1.5 sm:px-2 py-0.5 rounded-md bg-red-500/10 text-red-600 text-[10px] sm:text-[11px] font-semibold border border-red-500/15">
                    Selected
                  </span>
                )}
                <ChevronRight className="hidden sm:block w-4 h-4 text-neutral-300 group-hover:text-neutral-500 transition-colors" />
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(update.id); }}
                  aria-label="Delete topic"
                  className="p-2 -mr-1 rounded-lg sm:opacity-0 sm:group-hover:opacity-100 hover:bg-red-500/10 active:bg-red-500/15 text-neutral-400 hover:text-red-400 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Detail drawer */}
      {selectedTopicDetails && (
        <div
          className="fixed inset-0 z-[60] flex justify-end animate-fade-in"
          style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
          onClick={() => setSelectedTopicDetails(null)}
        >
          <div
            className="w-full sm:max-w-lg bg-white sm:border-l border-black/[0.11] h-full overflow-y-auto flex flex-col animate-slide-right"
            onClick={e => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white/95 backdrop-blur-md border-b border-black/[0.10] px-4 sm:px-6 py-4 sm:py-5 z-10">
              <div className="flex items-start justify-between gap-3 sm:gap-4">
                <div className="flex-1 min-w-0">
                  <h2 className="text-sm sm:text-base font-semibold text-black leading-snug pr-2">{selectedTopicDetails.title}</h2>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className="text-[11px] sm:text-xs px-2 py-0.5 rounded-md bg-red-500/10 text-red-600 border border-red-500/20 font-medium">
                      {selectedTopicDetails.source}
                    </span>
                    {selectedTopicDetails.url && (
                      <a
                        href={selectedTopicDetails.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[11px] sm:text-xs text-neutral-500 hover:text-neutral-800 transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        View original
                      </a>
                    )}
                    {selectedTopicDetails.episode_id && (
                      <span className="text-[11px] sm:text-xs text-neutral-500 bg-black/[0.04] px-2 py-0.5 rounded border border-black/[0.08]">
                        Episode linked
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedTopicDetails(null)}
                  aria-label="Close"
                  className="p-2 rounded-lg bg-black/[0.05] hover:bg-black/[0.1] active:bg-black/[0.15] text-neutral-600 hover:text-black transition-colors shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 px-4 sm:px-6 py-5 sm:py-6 text-neutral-800 text-sm leading-relaxed whitespace-pre-wrap pb-[calc(env(safe-area-inset-bottom)+1rem)]">
              {selectedTopicDetails.content || "No content available."}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
