"use client";

import { useEffect, useState, useCallback, Suspense, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Sparkles, Loader2, RefreshCw, Save, ArrowLeft, ArrowRight, AlertCircle,
  Globe, ExternalLink, ListChecks, Lightbulb, Eye, Compass, Brain, CheckCircle2, Circle,
} from "lucide-react";
import { getAnalyzableUpdates, updateTopicAnalysis, type TopicAnalysis } from "../actions/updates";
import { getEpisodes } from "../actions/episodes";
import { episodeStatus } from "../lib/episodeStatus";

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
};

function AnalyticsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const episodeFromUrl = params.get("episode") || "";
  const languageFromUrl = (params.get("lang") === "tenglish" ? "tenglish" : "english") as "english" | "tenglish";

  // Episode metadata is editable on this page — pre-filled from the URL when
  // the user arrives from Topic Discovery, otherwise empty so they can name
  // the episode from here.
  const [episodeName, setEpisodeName] = useState(episodeFromUrl);
  const [language, setLanguage] = useState<"english" | "tenglish">(languageFromUrl);

  const [rows, setRows] = useState<RowState[]>([]);
  const [pageStatus, setPageStatus] = useState<"loading" | "ready" | "no-topics">("loading");
  const [bulkStatus, setBulkStatus] = useState("");
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);
  const [scriptStatus, setScriptStatus] = useState("");
  // Episodes that haven't produced a final script yet — listed below the topic
  // list so the user can jump straight into an in-progress / failed episode.
  const [resumeCandidates, setResumeCandidates] = useState<any[]>([]);
  const ranInitial = useRef(false);

  // Keep local state in sync if the URL changes (e.g., user clicks a resume link).
  useEffect(() => { setEpisodeName(episodeFromUrl); }, [episodeFromUrl]);
  useEffect(() => { setLanguage(languageFromUrl); }, [languageFromUrl]);

  // Load the candidate topic list once on mount, regardless of episode name.
  useEffect(() => {
    (async () => {
      const candidates = (await getAnalyzableUpdates()) as Topic[];
      setRows(candidates.map(t => ({
        topic: t,
        analysis: asAnalysis(t.analysis_json),
        // Currently-selected topics are included by default; previously-analyzed
        // pending topics are off by default — the user can opt them in.
        included: t.status === 'selected',
        loading: !t.analysis_json,
        rerunning: false,
        saving: false,
        saved: false,
      })));
      setPageStatus(candidates.length ? "ready" : "no-topics");

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

  // Kick off analysis for any topic that doesn't have one yet (once per mount).
  useEffect(() => {
    if (pageStatus !== "ready" || ranInitial.current) return;
    const missing = rows.filter(r => !r.topic.analysis_json).map(r => r.topic.id);
    if (!missing.length) return;
    ranInitial.current = true;
    runAnalytics(missing, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageStatus]);

  const runAnalytics = useCallback(async (topicIds: string[], force: boolean) => {
    if (!topicIds.length) return;
    setBulkStatus(`Searching the web + analyzing ${topicIds.length} topic${topicIds.length === 1 ? "" : "s"}…`);
    setRows(prev => prev.map(r => topicIds.includes(r.topic.id) ? { ...r, loading: !force, rerunning: force, error: undefined } : r));

    try {
      const res = await fetch("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicIds, force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analytics request failed");

      setRows(prev => prev.map(r => {
        const result = data.results?.find((x: any) => x.id === r.topic.id);
        if (!result) return r;
        if (result.error) {
          return { ...r, loading: false, rerunning: false, error: result.error };
        }
        return {
          ...r,
          loading: false,
          rerunning: false,
          analysis: asAnalysis(result.analysis),
          error: undefined,
        };
      }));
      setBulkStatus(`Analysis ready for ${data.analyzed} topic${data.analyzed === 1 ? "" : "s"}.`);
      setTimeout(() => setBulkStatus(""), 3500);
    } catch (e: any) {
      console.error(e);
      setBulkStatus("");
      setRows(prev => prev.map(r => topicIds.includes(r.topic.id)
        ? { ...r, loading: false, rerunning: false, error: e.message }
        : r));
    }
  }, []);

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
        body: JSON.stringify({ episodeId: episodeName, topics: payloadTopics, language }),
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
        setTimeout(() => router.push("/script-studio"), 1200);
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
      <div className="flex items-center justify-center h-64 gap-3 text-slate-500">
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
        cta={() => router.push("/")}
        resumeCandidates={resumeCandidates}
      />
    );
  }

  const allReady = rows.every(r => !r.loading && !r.rerunning);
  const someError = rows.some(r => r.error);
  const includedCount = rows.filter(r => r.included).length;
  const hasReusable = rows.some(r => r.topic.status !== 'selected');
  const canGenerate = !!episodeName.trim() && includedCount > 0 && allReady && !isGeneratingScript;

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-up pb-36 sm:pb-32">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:gap-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-600 mb-1">
              <button onClick={() => router.push("/")} className="hover:text-slate-300 flex items-center gap-1 transition-colors">
                <ArrowLeft className="w-3 h-3" /> Topic Discovery
              </button>
              <span>/</span>
              <span className="text-slate-400">Analytics</span>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-white">
              {episodeName.trim()
                ? <>Analytics for <span className="text-indigo-300 break-all">{episodeName}</span></>
                : "Analyzed Topics"}
            </h1>
            <p className="text-slate-500 text-xs sm:text-sm mt-1">
              Tavily web search + Mistral Large reasoning per topic. Pick which topics go in, edit the briefs, then generate the script.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-slate-600 bg-white/[0.04] border border-white/[0.06] px-2.5 py-1 rounded-lg">
              {rows.length} topic{rows.length === 1 ? "" : "s"}
            </span>
            <span className="text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-lg">
              {includedCount} in script
            </span>
            {bulkStatus && (
              <span className="text-xs text-indigo-300 flex items-center gap-1.5 animate-fade-in w-full sm:w-auto">
                <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                <span className="truncate">{bulkStatus}</span>
              </span>
            )}
          </div>
        </div>

        {/* Episode metadata — editable so the user can name the episode from
            this page when they navigated here directly from the sidebar. */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 bg-[#13131f] border border-white/[0.07] rounded-2xl p-2 shadow-xl">
          <input
            type="text"
            value={episodeName}
            onChange={e => setEpisodeName(e.target.value)}
            placeholder="Episode name (e.g. Ep-01)"
            className="bg-transparent outline-none text-sm text-slate-200 placeholder-slate-600 px-3 py-1.5 flex-1 min-w-0"
          />
          <div className="hidden sm:block w-px h-5 bg-white/10 shrink-0" />
          <div className="flex items-center gap-0.5 bg-[#0c0c18] p-0.5 rounded-lg border border-white/[0.06] shrink-0" title="Script language">
            {(["english", "tenglish"] as const).map(lang => (
              <button
                key={lang}
                type="button"
                onClick={() => setLanguage(lang)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all capitalize ${
                  language === lang ? "bg-indigo-500 text-white shadow" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {lang}
              </button>
            ))}
          </div>
        </div>
      </div>

      {someError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-300 flex items-start gap-2">
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
      <div className="fixed bottom-0 left-0 md:left-60 right-0 bg-gradient-to-t from-[#0a0a14] via-[#0a0a14]/95 to-transparent pt-5 sm:pt-6 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:pb-5 px-3 sm:px-6 md:px-8 z-30 pointer-events-none">
        <div className="max-w-6xl mx-auto bg-[#13131f] border border-white/[0.08] rounded-2xl px-3 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 shadow-2xl pointer-events-auto">
          <div className="flex items-center gap-2 sm:gap-3 text-sm min-w-0 flex-wrap">
            {!allReady ? (
              <span className="flex items-center gap-2 text-slate-400 text-xs sm:text-sm">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                Analysis still running…
              </span>
            ) : !episodeName.trim() ? (
              <span className="flex items-center gap-2 text-amber-300 text-xs sm:text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Name the episode above to generate a script.
              </span>
            ) : includedCount === 0 ? (
              <span className="flex items-center gap-2 text-amber-300 text-xs sm:text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Pick at least one topic to include.
              </span>
            ) : (
              <span className="flex items-center gap-2 text-emerald-400 text-xs sm:text-sm">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                {includedCount} topic{includedCount === 1 ? "" : "s"} ready for the script
              </span>
            )}
            {scriptStatus && (
              <span className="text-[11px] sm:text-xs text-indigo-300 flex items-center gap-1.5 min-w-0">
                <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                <span className="truncate">{scriptStatus}</span>
              </span>
            )}
          </div>
          <button
            onClick={handleGenerateScript}
            disabled={!canGenerate}
            className="flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm px-4 sm:px-5 py-2.5 sm:py-2 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-500/20 w-full sm:w-auto"
          >
            {isGeneratingScript ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {isGeneratingScript ? "Generating…" : `Generate Script${includedCount > 0 ? ` (${includedCount})` : ""}`}
            {!isGeneratingScript && <ArrowRight className="w-3.5 h-3.5" />}
          </button>
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
    <div className="flex flex-col items-center justify-center py-16 bg-[#13131f] border border-white/[0.06] rounded-2xl gap-5 animate-fade-up px-6">
      <div className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/[0.07] flex items-center justify-center">
        <Brain className="w-7 h-7 text-slate-700" />
      </div>
      <div className="text-center max-w-md">
        <p className="text-slate-300 font-medium">{title}</p>
        <p className="text-slate-600 text-sm mt-1.5">{body}</p>
      </div>
      <button
        onClick={cta}
        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-500/20"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Topic Discovery
      </button>

      {resumeCandidates && resumeCandidates.length > 0 && (
        <div className="w-full max-w-md mt-2 pt-5 border-t border-white/[0.05] space-y-2">
          <p className="text-xs text-slate-600 uppercase tracking-wider font-semibold text-center">
            Or resume an in-progress episode
          </p>
          {resumeCandidates.map(ep => {
            const s = episodeStatus(ep);
            const lang = ep.analysis_json?.language === "tenglish" ? "tenglish" : "english";
            return (
              <button
                key={ep.id}
                onClick={() => router.push(`/analytics?episode=${encodeURIComponent(ep.week_id)}&lang=${lang}`)}
                className="w-full flex items-center justify-between gap-3 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] rounded-xl px-4 py-3 text-left transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-200 truncate">{ep.week_id}</div>
                  <div className={`text-[11px] mt-0.5 flex items-center gap-1 ${
                    s === "failed" ? "text-red-400" : "text-amber-400"
                  }`}>
                    {s === "failed" ? <AlertCircle className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
                    {s === "failed" ? "Failed — retry" : "Generating…"}
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-500 shrink-0" />
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
  const { topic, analysis, included, loading, rerunning, saving, saved, error } = row;
  const busy = loading || rerunning;
  const hasAnalysis = !!topic.analysis_json;
  const fromPriorSession = topic.status !== 'selected';

  return (
    <div className={`bg-[#13131f] border rounded-2xl overflow-hidden card-glow transition-colors ${
      included ? "border-white/[0.06]" : "border-white/[0.04] opacity-70"
    }`}>
      {/* Header */}
      <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-white/[0.05] bg-white/[0.01] flex flex-wrap items-start gap-3">
        <button
          onClick={onToggleIncluded}
          aria-label={included ? "Exclude from script" : "Include in script"}
          title={included ? "Excluding this topic from the script" : "Including this topic in the script"}
          className="shrink-0 mt-0.5"
        >
          {included
            ? <CheckCircle2 className="w-5 h-5 text-emerald-400 hover:text-emerald-300 transition-colors" />
            : <Circle className="w-5 h-5 text-slate-600 hover:text-slate-400 transition-colors" />}
        </button>
        <span className="shrink-0 w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-bold flex items-center justify-center">
          {index}
        </span>
        <div className="flex-1 min-w-[60%] sm:min-w-0">
          <h3 className="text-white font-semibold text-sm sm:text-[15px] leading-snug">{topic.title}</h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-[11px] text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded border border-white/[0.05]">
              {topic.source}
            </span>
            {hasAnalysis && fromPriorSession && (
              <span className="text-[10px] text-emerald-300/90 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 font-medium">
                Previously analyzed
              </span>
            )}
            {topic.url && (
              <a
                href={topic.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-slate-500 hover:text-indigo-300 transition-colors flex items-center gap-1"
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
            className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] active:bg-white/[0.12] disabled:opacity-40 text-slate-300 text-xs px-2.5 py-1.5 rounded-lg border border-white/[0.06] transition-all"
          >
            {rerunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            <span className="hidden xs:inline sm:inline">Re-analyze</span>
          </button>
          <button
            onClick={onSave}
            disabled={busy || saving}
            className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] active:bg-white/[0.12] disabled:opacity-40 text-slate-300 text-xs px-2.5 py-1.5 rounded-lg border border-white/[0.06] transition-all"
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
        <div className="px-5 py-10 flex items-center justify-center gap-2.5 text-slate-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          {rerunning ? "Re-running web search and reasoning…" : "Searching the web and running analysis…"}
        </div>
      ) : error ? (
        <div className="px-5 py-5 text-sm text-red-300 bg-red-500/5 border-y border-red-500/10 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium">Couldn't run analysis</div>
            <div className="text-xs text-red-300/70 mt-1">{error}</div>
            <div className="text-xs text-slate-500 mt-2">You can still edit the fields below manually.</div>
          </div>
        </div>
      ) : null}

      {!busy && (
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
            <div className="pt-2 border-t border-white/[0.05]">
              <div className="flex items-center gap-1.5 text-[11px] text-slate-600 uppercase tracking-wider font-semibold mb-2">
                <Globe className="w-3 h-3" /> Web sources consulted
              </div>
              <div className="flex flex-wrap gap-1.5">
                {analysis.sources.map((s, i) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-slate-500 hover:text-indigo-300 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.05] px-2 py-1 rounded-md transition-colors max-w-[280px] truncate flex items-center gap-1"
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

function Field({
  icon, label, hint, value, onChange, rows = 3,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 sm:gap-3 mb-1.5">
        <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5 shrink-0">
          <span className="text-indigo-400">{icon}</span>
          {label}
        </label>
        <span className="text-[11px] text-slate-600 sm:text-right">{hint}</span>
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className="w-full bg-[#0c0c18] border border-white/[0.06] rounded-xl px-3.5 py-2.5 text-sm text-slate-200 leading-relaxed focus:outline-none focus:border-indigo-500/40 transition-colors resize-y"
      />
    </div>
  );
}

function KeyFactsField({
  facts, onChange,
}: { facts: string[]; onChange: (next: string[]) => void }) {
  // Internal textarea representation — one fact per line, easy to edit.
  const text = facts.join("\n");
  const handle = (v: string) => {
    const next = v.split("\n").map(s => s.replace(/^[-•*\s]+/, "").trim()).filter(Boolean);
    onChange(next);
  };
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 sm:gap-3 mb-1.5">
        <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5 shrink-0">
          <span className="text-indigo-400"><ListChecks className="w-3.5 h-3.5" /></span>
          Key facts
        </label>
        <span className="text-[11px] text-slate-600 sm:text-right">One fact per line — concrete, numerical when possible.</span>
      </div>
      <textarea
        value={text}
        onChange={e => handle(e.target.value)}
        rows={Math.max(4, facts.length + 1)}
        spellCheck={false}
        placeholder="• 4 parallel agents&#10;• 256K context window&#10;• Free during preview"
        className="w-full bg-[#0c0c18] border border-white/[0.06] rounded-xl px-3.5 py-2.5 text-sm text-slate-200 leading-relaxed focus:outline-none focus:border-indigo-500/40 transition-colors resize-y font-[ui-monospace,Menlo,monospace]"
      />
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64 gap-3 text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading analytics…</span>
      </div>
    }>
      <AnalyticsInner />
    </Suspense>
  );
}
