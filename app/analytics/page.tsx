"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Sparkles, Loader2, RefreshCw, Save, ArrowLeft, ArrowRight, AlertCircle,
  Globe, ExternalLink, Lightbulb, Eye, Compass, Brain, CheckCircle2, Circle,
} from "lucide-react";
import { getAnalyzableUpdates, getUpdateById, updateTopicAnalysis, type TopicAnalysis } from "../actions/updates";
import { getEpisodes } from "../actions/episodes";
import { episodeStatus } from "../lib/episodeStatus";
import { currentWeekId } from "../lib/weekId";
import { progressStepText, type AnalysisProgress } from "../lib/analysisProgress";
import { Field, KeyFactsField } from "../components/BriefFields";

const EMPTY: TopicAnalysis = {
  summary: "", whyNow: "", keyFacts: [], biggerPicture: "", honestTake: "", sources: [],
};

function asAnalysis(raw: any): TopicAnalysis {
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  return {
    summary:       String(raw.summary       || "").trim(),
    whyNow:        String(raw.whyNow        || raw.why_now        || "").trim(),
    keyFacts:      Array.isArray(raw.keyFacts || raw.key_facts)
                    ? (raw.keyFacts || raw.key_facts).map((s: any) => String(s))
                    : [],
    biggerPicture: String(raw.biggerPicture || raw.bigger_picture || "").trim(),
    honestTake:    String(raw.honestTake    || raw.honest_take    || "").trim(),
    sources:       Array.isArray(raw.sources) ? raw.sources : [],
  };
}

type Topic = {
  id: string;
  title: string;
  source: string;
  url?: string;
  content?: string;
  analysis_json?: any;
  status?: string;
};

type RowState = {
  topic: Topic;
  analysis: TopicAnalysis;
  // Whether the user wants this topic to feed into the next script. Defaults
  // to true for currently-selected topics, false for previously-analyzed ones
  // the user hadn't re-selected.
  included: boolean;
  // UI state
  loading: boolean;        // initial analysis in-flight
  rerunning: boolean;      // user clicked "Re-analyze"
  saving: boolean;
  saved: boolean;
  error?: string;
  progress?: AnalysisProgress;
};

function AnalyticsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const episodeFromUrl = params.get("episode") || "";

  // Auto-filled so generating a script never blocks on typing a name first —
  // still editable if the user wants to rename it (e.g. to "Ep-01").
  const [episodeName, setEpisodeName] = useState(episodeFromUrl || currentWeekId());

  const [rows, setRows] = useState<RowState[]>([]);
  const [pageStatus, setPageStatus] = useState<"loading" | "ready" | "no-topics">("loading");
  const [bulkStatus, setBulkStatus] = useState("");
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);
  const [scriptStatus, setScriptStatus] = useState("");
  // Episodes that haven't produced a final script yet — listed below the topic
  // list so the user can jump straight into an in-progress / failed episode.
  const [resumeCandidates, setResumeCandidates] = useState<any[]>([]);

  // Cross-topic Reel/Video scoring — a deliberate action over a date range,
  // decoupled from the (now automatic, per-topic) brief generation above.
  // Defaults to the last 7 days; editable if that doesn't match how the
  // user actually batched their reading.
  const [scoreDateFrom, setScoreDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [scoreDateTo, setScoreDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [isScoring, setIsScoring] = useState(false);
  const [scoreStatus, setScoreStatus] = useState("");

  // Only sync from the URL when it actually carries a value — otherwise this
  // would stomp the auto-filled currentWeekId() default back to "" on mount.
  useEffect(() => { if (episodeFromUrl) setEpisodeName(episodeFromUrl); }, [episodeFromUrl]);

  const loadTopics = useCallback(async () => {
    const candidates = (await getAnalyzableUpdates()) as Topic[];
    setRows(candidates.map(t => ({
      topic: t,
      analysis: asAnalysis(t.analysis_json),
      included: t.status === 'selected',
      loading: false,
      rerunning: false,
      saving: false,
      saved: false,
    })));
    setPageStatus(candidates.length ? "ready" : "no-topics");
  }, []);

  const runScoring = useCallback(async () => {
    if (!scoreDateFrom || !scoreDateTo) return;
    setIsScoring(true);
    setScoreStatus("Scoring topics in range…");
    try {
      const res = await fetch("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFrom: scoreDateFrom, dateTo: scoreDateTo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Scoring failed");
      setScoreStatus(`Scored ${data.scored} topic${data.scored === 1 ? "" : "s"}.`);
      await loadTopics();
    } catch (e: any) {
      setScoreStatus(e.message || "Scoring failed");
    } finally {
      setIsScoring(false);
      setTimeout(() => setScoreStatus(""), 4000);
    }
  }, [scoreDateFrom, scoreDateTo, loadTopics]);

  // Load the candidate topic list once on mount, regardless of episode name.
  useEffect(() => {
    (async () => {
      await loadTopics();

      // Background-load any resume candidates regardless — used in the empty
      // state and as a sidebar of in-progress episodes.
      const eps = await getEpisodes();
      setResumeCandidates(
        (eps as any[]).filter(e => {
          const s = episodeStatus(e);
          return s === "generating" || s === "failed";
        }),
      );
    })();
  }, []);

  const toggleIncluded = (id: string) => {
    setRows(prev => prev.map(r => r.topic.id === id ? { ...r, included: !r.included } : r));
  };

  const runAnalytics = useCallback(async (topicIds: string[], force: boolean) => {
    if (!topicIds.length) return;
    setBulkStatus(`Searching the web + analyzing ${topicIds.length} topic${topicIds.length === 1 ? "" : "s"}…`);
    setRows(prev => prev.map(r => topicIds.includes(r.topic.id) ? { ...r, loading: !force, rerunning: force, error: undefined, progress: undefined } : r));

    let res: Response;
    try {
      res = await fetch("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // skipScoring: this is brief generation/retry for one or a few topics
        // at a time — cross-topic Reel/Video scoring is a separate, explicit
        // date-range action below, not something a single retry should imply.
        body: JSON.stringify({ topicIds, force, skipScoring: true }),
      });
    } catch (e: any) {
      // Network-level failure — the connection to our own API dropped, but
      // the server keeps working independently. Don't mark rows failed; the
      // progress poller below (keyed on loading/rerunning) discovers the
      // real outcome once the server finishes.
      console.warn("[Analytics] Connection to /api/analytics dropped — relying on progress polling.", e);
      return;
    }

    try {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analytics request failed");

      setRows(prev => prev.map(r => {
        const result = data.results?.find((x: any) => x.id === r.topic.id);
        if (!result) return r;
        if (result.error) {
          return { ...r, loading: false, rerunning: false, error: result.error, progress: undefined };
        }
        return {
          ...r,
          topic: { ...r.topic, analysis_json: result.analysis },
          loading: false,
          rerunning: false,
          analysis: asAnalysis(result.analysis),
          error: undefined,
          progress: undefined,
        };
      }));
      setBulkStatus(`Analysis ready for ${data.analyzed} topic${data.analyzed === 1 ? "" : "s"}.`);
      setTimeout(() => setBulkStatus(""), 3500);
    } catch (e: any) {
      console.error(e);
      setBulkStatus("");
      setRows(prev => prev.map(r => topicIds.includes(r.topic.id)
        ? { ...r, loading: false, rerunning: false, error: e.message, progress: undefined }
        : r));
    }
  }, []);

  // Live progress + settlement: while any rows are analyzing, poll their
  // analysis_progress/analysis_json directly from the DB. This is the
  // single source of truth for done/failed for each row — independent of
  // whether the fetch in runAnalytics is still connected, because a dropped
  // client connection does not stop the server-side work.
  const busyKey = rows.filter(r => r.loading || r.rerunning).map(r => r.topic.id).sort().join(",");
  useEffect(() => {
    if (!busyKey) return;
    let cancelled = false;
    const poll = async () => {
      const ids = busyKey.split(",");
      let fetched: any[];
      try {
        fetched = await Promise.all(ids.map(id => getUpdateById(id)));
      } catch (e) {
        console.warn("[Analytics] Progress poll failed, will retry", e);
        return;
      }
      if (cancelled) return;
      setRows(prev => prev.map(r => {
        const t = fetched.find(f => f?.id === r.topic.id);
        if (!t) return r;
        if (t.analysis_json) {
          return {
            ...r,
            topic: { ...r.topic, analysis_json: t.analysis_json },
            loading: false,
            rerunning: false,
            analysis: asAnalysis(t.analysis_json),
            error: undefined,
            progress: undefined,
          };
        }
        if (t.analysis_progress?.step === "failed") {
          return { ...r, loading: false, rerunning: false, error: t.analysis_progress.error || "Analysis failed", progress: undefined };
        }
        return { ...r, progress: t.analysis_progress || null };
      }));
    };
    poll();
    const interval = setInterval(poll, 2500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [busyKey]);

  const patchAnalysis = (id: string, patch: Partial<TopicAnalysis>) => {
    setRows(prev => prev.map(r => r.topic.id === id
      ? { ...r, analysis: { ...r.analysis, ...patch }, saved: false }
      : r));
  };

  const saveOne = async (id: string) => {
    const row = rows.find(r => r.topic.id === id);
    if (!row) return;
    setRows(prev => prev.map(r => r.topic.id === id ? { ...r, saving: true } : r));
    try {
      await updateTopicAnalysis(id, row.analysis);
      setRows(prev => prev.map(r => r.topic.id === id ? { ...r, saving: false, saved: true } : r));
      setTimeout(() => setRows(prev => prev.map(r => r.topic.id === id ? { ...r, saved: false } : r)), 2000);
    } catch (e: any) {
      setRows(prev => prev.map(r => r.topic.id === id ? { ...r, saving: false, error: e.message } : r));
    }
  };

  const handleGenerateScript = async () => {
    if (!episodeName) return;
    // Only rows the user has checked AND that are done analyzing get sent
    // to the script writer.
    const usable = rows.filter(r => r.included && !r.loading && !r.rerunning);
    if (!usable.length) return;

    setIsGeneratingScript(true);
    setScriptStatus("Saving your edits…");

    try {
      // Persist every analysis as it stands on screen.
      await Promise.all(usable.map(r => updateTopicAnalysis(r.topic.id, r.analysis)));

      setScriptStatus("Sending briefs to the script writer…");
      const payloadTopics = usable.map(r => ({
        id: r.topic.id,
        title: r.topic.title,
        source: r.topic.source,
        content: r.topic.content,
        analysis_json: r.analysis,
      }));

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId: episodeName, topics: payloadTopics }),
      });
      if (!res.ok) throw new Error("Failed to start script generation");

      setScriptStatus("Generating podcast script…");
      let isDone = false;
      let attempts = 0;
      while (!isDone && attempts < 60) {
        await new Promise(r => setTimeout(r, 4000));
        attempts++;
        setScriptStatus(`Generating podcast script… (${attempts * 4}s elapsed)`);
        const eps = await getEpisodes();
        if (eps.find((e: any) => e.week_id === episodeName && e.script_text)) isDone = true;
      }

      if (isDone) {
        setScriptStatus("Script ready — opening Script Studio…");
        setTimeout(() => router.push("/podcast"), 1200);
      } else {
        setScriptStatus("Still processing in background — check Script Studio in a minute.");
        setTimeout(() => setIsGeneratingScript(false), 4000);
      }
    } catch (e: any) {
      setScriptStatus(`Error: ${e.message}`);
      setTimeout(() => { setIsGeneratingScript(false); setScriptStatus(""); }, 4000);
    }
  };

  // ── Render states ─────────────────────────────────────────────────────────
  if (pageStatus === "loading") {
    return (
      <div className="flex items-center justify-center h-64 gap-3 text-neutral-500">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading analyzed topics…</span>
      </div>
    );
  }
  if (pageStatus === "no-topics") {
    return (
      <EmptyState
        title="No analyzed topics yet"
        body="Head back to Topic Discovery, pick the stories you want, and click Analyze Topics."
        cta={() => router.push("/discover")}
        resumeCandidates={resumeCandidates}
      />
    );
  }

  const allReady = rows.every(r => !r.loading && !r.rerunning);
  const someError = rows.some(r => r.error);
  const includedCount = rows.filter(r => r.included).length;
  const hasReusable = rows.some(r => r.topic.status !== 'selected');
  const unanalyzedIds = rows
    .filter(r => !r.topic.analysis_json && !r.loading && !r.rerunning)
    .map(r => r.topic.id);
  const allIncludedHaveAnalysis = rows
    .filter(r => r.included)
    .every(r => !!r.topic.analysis_json);
  const canAnalyze = unanalyzedIds.length > 0 && allReady;
  const canGenerate = !!episodeName.trim() && includedCount > 0 && allReady && !isGeneratingScript && allIncludedHaveAnalysis;

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-up pb-36 sm:pb-32">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:gap-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-neutral-400 mb-1">
              <button onClick={() => router.push("/discover")} className="hover:text-neutral-800 flex items-center gap-1 transition-colors">
                <ArrowLeft className="w-3 h-3" /> Topic Discovery
              </button>
              <span>/</span>
              <span className="text-neutral-600">Analytics</span>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-black">
              {episodeName.trim()
                ? <>Analytics for <span className="text-red-600 break-all">{episodeName}</span></>
                : "Analyzed Topics"}
            </h1>
            <p className="text-neutral-500 text-xs sm:text-sm mt-1">
              Firecrawl web search + Mistral Large reasoning per topic. Pick which topics go in, edit the briefs, then generate the script.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-neutral-400 bg-black/[0.04] border border-black/[0.08] px-2.5 py-1 rounded-lg">
              {rows.length} topic{rows.length === 1 ? "" : "s"}
            </span>
            <span className="text-[11px] text-emerald-600 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-lg">
              {includedCount} in script
            </span>
            {bulkStatus && (
              <span className="text-xs text-red-600 flex items-center gap-1.5 animate-fade-in w-full sm:w-auto">
                <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                <span className="truncate">{bulkStatus}</span>
              </span>
            )}
          </div>
        </div>

        {/* Episode metadata — editable so the user can name the episode from
            this page when they navigated here directly from the sidebar. */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 bg-white border border-black/[0.09] rounded-2xl p-2 shadow-xl">
          <input
            type="text"
            value={episodeName}
            onChange={e => setEpisodeName(e.target.value)}
            placeholder="Episode name (e.g. Ep-01)"
            className="bg-transparent outline-none text-sm text-neutral-900 placeholder-neutral-400 px-3 py-1.5 flex-1 min-w-0"
          />
        </div>

        {/* Cross-topic Reel/Video scoring — a deliberate, date-scoped action.
            Briefs generate automatically per topic; scoring compares topics
            against each other, so it needs an explicit batch to compare. */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 bg-white border border-black/[0.09] rounded-2xl p-2 shadow-xl">
          <div className="flex items-center gap-1.5 px-2 text-xs text-neutral-500 whitespace-nowrap">
            Score topics from
          </div>
          <input
            type="date"
            value={scoreDateFrom}
            onChange={e => setScoreDateFrom(e.target.value)}
            className="bg-[#f5f5f5] border border-black/[0.08] rounded-lg outline-none text-sm text-neutral-900 px-2.5 py-1.5"
          />
          <span className="text-xs text-neutral-400">to</span>
          <input
            type="date"
            value={scoreDateTo}
            onChange={e => setScoreDateTo(e.target.value)}
            className="bg-[#f5f5f5] border border-black/[0.08] rounded-lg outline-none text-sm text-neutral-900 px-2.5 py-1.5"
          />
          <button
            onClick={runScoring}
            disabled={isScoring}
            className="flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-500 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm px-4 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-red-500/20 whitespace-nowrap sm:ml-auto"
          >
            {isScoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {isScoring ? "Scoring…" : "Score Range"}
          </button>
          {scoreStatus && (
            <span className="text-xs text-neutral-500 px-2">{scoreStatus}</span>
          )}
        </div>
      </div>

      {someError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-600 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>One or more topics failed to analyze. You can edit them manually below, or click Re-analyze to retry.</span>
        </div>
      )}

      {hasReusable && (
        <div className="bg-emerald-500/[0.06] border border-emerald-500/15 rounded-xl px-4 py-3 text-sm text-emerald-200/90 flex items-start gap-2">
          <Brain className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Topics you previously analyzed but didn&apos;t use are listed below.
            Tick the ones you want in this script.
          </span>
        </div>
      )}

      {/* Topic cards */}
      <div className="space-y-5">
        {rows.map((row, idx) => (
          <TopicAnalysisCard
            key={row.topic.id}
            row={row}
            index={idx + 1}
            onToggleIncluded={() => toggleIncluded(row.topic.id)}
            onChange={patch => patchAnalysis(row.topic.id, patch)}
            onSave={() => saveOne(row.topic.id)}
            onRerun={() => runAnalytics([row.topic.id], true)}
          />
        ))}
      </div>

      {/* Sticky action bar — spans content area, respects sidebar on md+ */}
      <div className="fixed bottom-0 left-0 md:left-60 right-0 bg-gradient-to-t from-white via-white/95 to-transparent pt-5 sm:pt-6 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:pb-5 px-3 sm:px-6 md:px-8 z-30 pointer-events-none">
        <div className="max-w-6xl mx-auto bg-white border border-black/[0.1] rounded-2xl px-3 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 shadow-2xl pointer-events-auto">
          <div className="flex items-center gap-2 sm:gap-3 text-sm min-w-0 flex-wrap">
            {!allReady ? (
              <span className="flex items-center gap-2 text-neutral-600 text-xs sm:text-sm">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                {bulkStatus || "Analysis running…"}
              </span>
            ) : !episodeName.trim() ? (
              <span className="flex items-center gap-2 text-amber-600 text-xs sm:text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Name the episode above to generate a script.
              </span>
            ) : includedCount === 0 ? (
              <span className="flex items-center gap-2 text-amber-600 text-xs sm:text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Pick at least one topic to include.
              </span>
            ) : !allIncludedHaveAnalysis ? (
              <span className="flex items-center gap-2 text-amber-600 text-xs sm:text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Analyze included topics first.
              </span>
            ) : (
              <span className="flex items-center gap-2 text-emerald-400 text-xs sm:text-sm">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                {includedCount} topic{includedCount === 1 ? "" : "s"} ready for the script
              </span>
            )}
            {scriptStatus && (
              <span className="text-[11px] sm:text-xs text-red-600 flex items-center gap-1.5 min-w-0">
                <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                <span className="truncate">{scriptStatus}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            {canAnalyze && (
              <button
                onClick={() => runAnalytics(unanalyzedIds, false)}
                className="flex items-center justify-center gap-2 bg-black/[0.06] hover:bg-black/[0.1] text-neutral-900 text-sm px-4 sm:px-4 py-2.5 sm:py-2 rounded-xl font-semibold transition-all border border-black/[0.1] flex-1 sm:flex-none"
              >
                <Sparkles className="w-4 h-4 text-red-600" />
                Analyze Topics ({unanalyzedIds.length})
              </button>
            )}
            <button
              onClick={handleGenerateScript}
              disabled={!canGenerate}
              className="flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500 active:bg-red-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm px-4 sm:px-5 py-2.5 sm:py-2 rounded-xl font-semibold transition-all shadow-lg shadow-red-500/20 flex-1 sm:flex-none"
            >
              {isGeneratingScript ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {isGeneratingScript ? "Generating…" : `Generate Script${includedCount > 0 ? ` (${includedCount})` : ""}`}
              {!isGeneratingScript && <ArrowRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  title, body, cta, resumeCandidates,
}: {
  title: string;
  body: string;
  cta: () => void;
  resumeCandidates?: any[];
}) {
  const router = useRouter();
  return (
    <div className="flex flex-col items-center justify-center py-16 bg-white border border-black/[0.08] rounded-2xl gap-5 animate-fade-up px-6">
      <div className="w-16 h-16 rounded-2xl bg-black/[0.03] border border-black/[0.09] flex items-center justify-center">
        <Brain className="w-7 h-7 text-neutral-300" />
      </div>
      <div className="text-center max-w-md">
        <p className="text-neutral-800 font-medium">{title}</p>
        <p className="text-neutral-400 text-sm mt-1.5">{body}</p>
      </div>
      <button
        onClick={cta}
        className="flex items-center gap-2 bg-red-600 hover:bg-red-500 text-white text-sm px-4 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-red-500/20"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Topic Discovery
      </button>

      {resumeCandidates && resumeCandidates.length > 0 && (
        <div className="w-full max-w-md mt-2 pt-5 border-t border-black/[0.07] space-y-2">
          <p className="text-xs text-neutral-400 uppercase tracking-wider font-semibold text-center">
            Or resume an in-progress episode
          </p>
          {resumeCandidates.map(ep => {
            const s = episodeStatus(ep);
            return (
              <button
                key={ep.id}
                onClick={() => router.push(`/analytics?episode=${encodeURIComponent(ep.week_id)}`)}
                className="w-full flex items-center justify-between gap-3 bg-black/[0.03] hover:bg-black/[0.06] border border-black/[0.08] rounded-xl px-4 py-3 text-left transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-neutral-900 truncate">{ep.week_id}</div>
                  <div className={`text-[11px] mt-0.5 flex items-center gap-1 ${
                    s === "failed" ? "text-red-400" : "text-amber-400"
                  }`}>
                    {s === "failed" ? <AlertCircle className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
                    {s === "failed" ? "Failed — retry" : "Generating…"}
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-neutral-500 shrink-0" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TopicAnalysisCard({
  row, index, onChange, onSave, onRerun, onToggleIncluded,
}: {
  row: RowState;
  index: number;
  onChange: (patch: Partial<TopicAnalysis>) => void;
  onSave: () => void;
  onRerun: () => void;
  onToggleIncluded: () => void;
}) {
  const { topic, analysis, included, loading, rerunning, saving, saved, error, progress } = row;
  const busy = loading || rerunning;
  const hasAnalysis = !!topic.analysis_json;
  const fromPriorSession = topic.status !== 'selected';
  const isPending = !busy && !hasAnalysis && !error;

  return (
    <div className={`bg-white border rounded-2xl overflow-hidden card-glow transition-colors ${
      included ? "border-black/[0.08]" : "border-black/[0.06] opacity-70"
    }`}>
      {/* Header */}
      <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-black/[0.07] bg-black/[0.01] flex flex-wrap items-start gap-3">
        <button
          onClick={onToggleIncluded}
          aria-label={included ? "Exclude from script" : "Include in script"}
          title={included ? "Excluding this topic from the script" : "Including this topic in the script"}
          className="shrink-0 mt-0.5"
        >
          {included
            ? <CheckCircle2 className="w-5 h-5 text-emerald-400 hover:text-emerald-500 transition-colors" />
            : <Circle className="w-5 h-5 text-neutral-400 hover:text-neutral-600 transition-colors" />}
        </button>
        <span className="shrink-0 w-7 h-7 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 text-xs font-bold flex items-center justify-center">
          {index}
        </span>
        <div className="flex-1 min-w-[60%] sm:min-w-0">
          <h3 className="text-black font-semibold text-sm sm:text-[15px] leading-snug">{topic.title}</h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-[11px] text-neutral-500 bg-black/[0.04] px-2 py-0.5 rounded border border-black/[0.07]">
              {topic.source}
            </span>
            {hasAnalysis && fromPriorSession && (
              <span className="text-[10px] text-emerald-600/90 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 font-medium">
                Previously analyzed
              </span>
            )}
            {topic.url && (
              <a
                href={topic.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-neutral-500 hover:text-red-600 transition-colors flex items-center gap-1"
              >
                <ExternalLink className="w-3 h-3" /> source
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          <button
            onClick={onRerun}
            disabled={busy}
            title="Re-run web search + analysis"
            className="flex items-center gap-1.5 bg-black/[0.04] hover:bg-black/[0.08] active:bg-black/[0.12] disabled:opacity-40 text-neutral-800 text-xs px-2.5 py-1.5 rounded-lg border border-black/[0.08] transition-all"
          >
            {rerunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            <span className="hidden xs:inline sm:inline">Re-analyze</span>
          </button>
          <button
            onClick={onSave}
            disabled={busy || saving}
            className="flex items-center gap-1.5 bg-black/[0.04] hover:bg-black/[0.08] active:bg-black/[0.12] disabled:opacity-40 text-neutral-800 text-xs px-2.5 py-1.5 rounded-lg border border-black/[0.08] transition-all"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" />
              : saved ? <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              : <Save className="w-3 h-3" />}
            {saved ? "Saved" : "Save"}
          </button>
        </div>
      </div>

      {/* Body */}
      {busy ? (
        <div className="px-5 py-8 flex flex-col items-center justify-center gap-2 text-neutral-500 text-sm text-center">
          <div className="flex items-center gap-2.5">
            <Loader2 className="w-4 h-4 animate-spin" />
            {progressStepText(progress ?? null)}
          </div>
          {progress?.sources && progress.sources.length > 0 && (
            <div className="flex flex-wrap gap-1.5 justify-center mt-1 max-w-md">
              {progress.sources.map((s, i) => (
                <a
                  key={i}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-neutral-500 hover:text-red-600 bg-black/[0.03] hover:bg-black/[0.06] border border-black/[0.07] px-2 py-1 rounded-md transition-colors max-w-[220px] truncate flex items-center gap-1"
                >
                  <Globe className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">{s.title || s.url}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      ) : error ? (
        <div className="px-5 py-5 text-sm text-red-600 bg-red-500/5 border-y border-red-500/10 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium">Couldn't run analysis</div>
            <div className="text-xs text-red-600/70 mt-1">{error}</div>
            <div className="text-xs text-neutral-500 mt-2">You can still edit the fields below manually.</div>
          </div>
        </div>
      ) : isPending ? (
        <div className="px-5 py-8 flex items-center justify-center gap-2.5 text-neutral-400 text-sm border-t border-black/[0.06]">
          <Circle className="w-4 h-4 shrink-0" />
          Not yet analyzed — click <span className="text-neutral-600 font-medium">Analyze Topics</span> to run
        </div>
      ) : null}

      {!busy && hasAnalysis && (
        <div className="p-4 sm:p-5 space-y-4">
          <Field
            icon={<Lightbulb className="w-3.5 h-3.5" />}
            label="Summary"
            hint="What actually happened, in plain English."
            value={analysis.summary}
            onChange={v => onChange({ summary: v })}
            rows={3}
          />
          <Field
            icon={<Compass className="w-3.5 h-3.5" />}
            label="Why now"
            hint="The catalyst — what pressure, competition, or opportunity drove this now?"
            value={analysis.whyNow}
            onChange={v => onChange({ whyNow: v })}
            rows={3}
          />
          <KeyFactsField
            facts={analysis.keyFacts}
            onChange={facts => onChange({ keyFacts: facts })}
          />
          <Field
            icon={<Eye className="w-3.5 h-3.5" />}
            label="Bigger picture"
            hint="What this means for the industry / consumers / people working in tech."
            value={analysis.biggerPicture}
            onChange={v => onChange({ biggerPicture: v })}
            rows={3}
          />
          <Field
            icon={<Brain className="w-3.5 h-3.5" />}
            label="Honest take"
            hint="Is this a big deal, hype, or complicated? Commit to a view."
            value={analysis.honestTake}
            onChange={v => onChange({ honestTake: v })}
            rows={2}
          />

          {analysis.sources && analysis.sources.length > 0 && (
            <div className="pt-2 border-t border-black/[0.07]">
              <div className="flex items-center gap-1.5 text-[11px] text-neutral-400 uppercase tracking-wider font-semibold mb-2">
                <Globe className="w-3 h-3" /> Web sources consulted
              </div>
              <div className="flex flex-wrap gap-1.5">
                {analysis.sources.map((s, i) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-neutral-500 hover:text-red-600 bg-black/[0.03] hover:bg-black/[0.06] border border-black/[0.07] px-2 py-1 rounded-md transition-colors max-w-[280px] truncate flex items-center gap-1"
                  >
                    <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{s.title || s.url}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64 gap-3 text-neutral-500">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading analytics…</span>
      </div>
    }>
      <AnalyticsInner />
    </Suspense>
  );
}
