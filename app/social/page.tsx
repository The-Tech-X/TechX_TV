"use client";

import { useState, useEffect, useCallback } from "react";
import { getScoredUpdates, saveOverride, getAllAnalyzedUpdateIds } from "../actions/social";
import {
  Camera, PlayCircle, Loader2, RefreshCw, ChevronDown, ChevronUp,
  Sparkles, AlertCircle, CheckCircle2, RotateCcw, Copy, Check,
  Calendar, Clapperboard, TrendingUp, ArrowRight, RotateCw,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

type Update = {
  id: string;
  title: string;
  source: string;
  social_score: number | null;
  recommended_platform: "instagram" | "youtube" | "none" | null;
  social_reasoning: string | null;
  platform_override: "instagram" | "youtube" | "none" | null;
  analysis_json: any;
  week_id: string | null;
  created_at: string;
};

// Instagram Reel script shape
type ReelScript = {
  hook: string;
  bullets: string[];
  cta: string;
};

// Full YouTube video script shape
type VideoScript = {
  hook: string;
  sections: { title: string; points: string[] }[];
  conclusion: string;
};

type ScriptState<T> = {
  loading: boolean;
  script: T | null;
  error: string | null;
};

type YouTubeConcept = {
  synthesized: {
    title: string;
    thesis: string;
    why: string;
    outline: { section: string; description: string }[];
  };
  best_single: {
    update_id: string | null;
    title: string;
    why: string;
  };
  recommendation: "synthesized" | "best_single";
  recommendation_reason: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 7.0;

function PlatformBadge({ platform }: { platform: string }) {
  if (platform === "instagram") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-pink-500/15 text-pink-300 border border-pink-500/25 uppercase tracking-wide">
        <Camera className="w-2.5 h-2.5" /> Reel
      </span>
    );
  }
  if (platform === "youtube") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-red-500/15 text-red-300 border border-red-500/25 uppercase tracking-wide">
        <PlayCircle className="w-2.5 h-2.5" /> Video
      </span>
    );
  }
  return null;
}

function ScoreBar({ score }: { score: number }) {
  const pct = (score / 10) * 100;
  const color = score >= 8 ? "bg-emerald-400" : score >= 6.5 ? "bg-amber-400" : "bg-slate-600";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-white/[0.06] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] font-semibold text-slate-400 w-7 text-right">{score.toFixed(1)}</span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-500 hover:text-slate-300 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// ── Instagram Reel Script Card ────────────────────────────────────────────────

function ReelScriptCard({ script }: { script: ReelScript }) {
  const fullText = [
    `HOOK:\n${script.hook}`,
    `\nTALKING POINTS:\n${script.bullets.map((b, i) => `${i + 1}. ${b}`).join("\n")}`,
    `\nCTA:\n${script.cta}`,
  ].join("\n");

  return (
    <div className="mt-3 bg-[#0c0c18] border border-white/[0.07] rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <PlatformBadge platform="instagram" />
        <CopyButton text={fullText} />
      </div>
      <div className="space-y-2.5">
        <div>
          <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-1">Hook (scripted)</p>
          <p className="text-sm text-white font-medium leading-snug bg-indigo-500/5 border border-indigo-500/15 rounded-lg px-3 py-2">
            {script.hook}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-1">Talking Points</p>
          <ol className="space-y-1.5">
            {script.bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-300 leading-snug">
                <span className="shrink-0 w-5 h-5 rounded-md bg-white/[0.05] text-slate-500 text-[10px] font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                {b}
              </li>
            ))}
          </ol>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-1">CTA (scripted)</p>
          <p className="text-sm text-slate-300 leading-snug bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2">{script.cta}</p>
        </div>
      </div>
    </div>
  );
}

// ── YouTube Video Script Card ─────────────────────────────────────────────────

function VideoScriptCard({ script }: { script: VideoScript }) {
  const fullText = [
    `HOOK:\n${script.hook}`,
    ...script.sections.map(s => `\n${s.title.toUpperCase()}:\n${s.points.map((p, i) => `${i + 1}. ${p}`).join("\n")}`),
    `\nCONCLUSION:\n${script.conclusion}`,
  ].join("\n");

  return (
    <div className="mt-3 bg-[#0c0c18] border border-white/[0.07] rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <PlatformBadge platform="youtube" />
        <CopyButton text={fullText} />
      </div>

      {/* Hook */}
      <div>
        <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-1">Hook (scripted)</p>
        <p className="text-sm text-white font-medium leading-relaxed bg-indigo-500/5 border border-indigo-500/15 rounded-lg px-3 py-2.5">
          {script.hook}
        </p>
      </div>

      {/* Sections */}
      {script.sections.map((section, si) => (
        <div key={si}>
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
            <span className="w-4 h-4 rounded bg-white/[0.06] text-slate-500 text-[9px] font-bold flex items-center justify-center">{si + 1}</span>
            {section.title}
          </p>
          <ol className="space-y-1.5">
            {section.points.map((p, pi) => (
              <li key={pi} className="flex items-start gap-2 text-sm text-slate-300 leading-snug">
                <span className="shrink-0 text-slate-600 text-[11px] mt-0.5">•</span>
                {p}
              </li>
            ))}
          </ol>
        </div>
      ))}

      {/* Conclusion */}
      <div>
        <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-1">Conclusion (scripted)</p>
        <p className="text-sm text-slate-300 leading-relaxed bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2.5">
          {script.conclusion}
        </p>
      </div>
    </div>
  );
}

// ── Topic Row ────────────────────────────────────────────────────────────────

function TopicRow({
  update,
  isIgnored,
  onOverride,
}: {
  update: Update;
  isIgnored: boolean;
  onOverride: (id: string, platform: "instagram" | "youtube") => void;
}) {
  const effectivePlatform = update.platform_override ?? update.recommended_platform ?? "none";
  const [igState, setIgState] = useState<ScriptState<ReelScript>>({ loading: false, script: null, error: null });
  const [ytState, setYtState] = useState<ScriptState<VideoScript>>({ loading: false, script: null, error: null });
  const [overriding, setOverriding] = useState(false);

  const generateScript = async (platform: "instagram" | "youtube") => {
    const setState = platform === "instagram"
      ? (s: ScriptState<ReelScript>) => setIgState(s)
      : (s: ScriptState<VideoScript>) => setYtState(s as any);
    setState({ loading: true, script: null, error: null } as any);
    try {
      const res = await fetch("/api/social-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updateId: update.id, platform }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setState({ loading: false, script: data.script, error: null } as any);
    } catch (e: any) {
      setState({ loading: false, script: null, error: e.message } as any);
    }
  };

  const handleOverride = async () => {
    const platform = update.recommended_platform === "youtube" ? "youtube" : "instagram";
    setOverriding(true);
    try {
      await saveOverride(update.id, platform);
      onOverride(update.id, platform);
    } catch {
      // silent fail — UI already optimistic
    } finally {
      setOverriding(false);
    }
  };

  const score = update.social_score ?? 0;

  return (
    <div className={`bg-[#13131f] border rounded-2xl overflow-hidden transition-colors ${
      isIgnored ? "border-white/[0.04] opacity-75" : "border-white/[0.07]"
    }`}>
      <div className="px-4 py-3.5 flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <PlatformBadge platform={effectivePlatform} />
            <span className="text-[10px] text-slate-600 bg-white/[0.04] px-2 py-0.5 rounded border border-white/[0.05]">{update.source}</span>
          </div>
          <h3 className="text-sm font-semibold text-white leading-snug">{update.title}</h3>
          {update.social_reasoning && (
            <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{update.social_reasoning}</p>
          )}
        </div>
        <div className="shrink-0 w-28">
          <ScoreBar score={score} />
        </div>
      </div>

      <div className="px-4 pb-3.5 flex items-center gap-2 flex-wrap">
        {isIgnored ? (
          <button
            onClick={handleOverride}
            disabled={overriding}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-indigo-500/15 hover:text-indigo-300 text-slate-400 border border-white/[0.06] hover:border-indigo-500/25 transition-all disabled:opacity-50"
          >
            {overriding ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            Override — include anyway
          </button>
        ) : (
          <>
            <button
              onClick={() => generateScript("instagram")}
              disabled={igState.loading}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-pink-500/10 hover:bg-pink-500/20 text-pink-300 border border-pink-500/20 hover:border-pink-500/35 transition-all disabled:opacity-50"
            >
              {igState.loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Camera className="w-3 h-3" />}
              {igState.loading ? "Generating…" : "Gen Reel Script"}
            </button>
            <button
              onClick={() => generateScript("youtube")}
              disabled={ytState.loading}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 hover:border-red-500/35 transition-all disabled:opacity-50"
            >
              {ytState.loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlayCircle className="w-3 h-3" />}
              {ytState.loading ? "Generating…" : "Gen YT Script"}
            </button>
          </>
        )}
      </div>

      {igState.error && (
        <div className="px-4 pb-3 text-xs text-red-300 flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {igState.error}
        </div>
      )}
      {ytState.error && (
        <div className="px-4 pb-3 text-xs text-red-300 flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {ytState.error}
        </div>
      )}
      {igState.script && (
        <div className="px-4 pb-4"><ReelScriptCard script={igState.script} /></div>
      )}
      {ytState.script && (
        <div className="px-4 pb-4"><VideoScriptCard script={ytState.script} /></div>
      )}
    </div>
  );
}

// ── YouTube Concept Panel ────────────────────────────────────────────────────

function YouTubeConceptPanel() {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo,   setDateTo]   = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [concept,  setConcept]  = useState<YouTubeConcept | null>(null);
  const [conceptId, setConceptId] = useState<string | null>(null);
  const [chosen,   setChosen]   = useState<"synthesized" | "best_single" | null>(null);
  const [scriptState, setScriptState] = useState<ScriptState<VideoScript>>({ loading: false, script: null, error: null });

  const generate = async () => {
    if (!dateFrom || !dateTo) return;
    setLoading(true);
    setError(null);
    setConcept(null);
    setChosen(null);
    setScriptState({ loading: false, script: null, error: null });
    try {
      const res = await fetch("/api/youtube-concept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFrom, dateTo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Concept generation failed");
      setConcept(data.concept);
      setConceptId(data.conceptId);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const generateScript = async () => {
    if (!concept || !chosen || !conceptId) return;
    setScriptState({ loading: true, script: null, error: null });
    try {
      const c = concept[chosen];
      const thesis = chosen === "synthesized"
        ? concept.synthesized.thesis
        : concept.best_single.why;
      const outline = chosen === "synthesized"
        ? concept.synthesized.outline.map(o => `${o.section}: ${o.description}`).join("\n")
        : "";

      const prompt = `Write a full-length YouTube video script for this concept.\n\nTitle: ${c.title}\nCentral thesis: ${thesis}\n${outline ? `Video outline:\n${outline}` : ""}`;

      const res = await fetch("/api/social-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updateId: chosen === "best_single" && concept.best_single.update_id
            ? concept.best_single.update_id
            : null,
          platform: "youtube",
          conceptOverride: { conceptId, prompt, title: c.title, thesis },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Script generation failed");
      setScriptState({ loading: false, script: data.script, error: null });
    } catch (e: any) {
      setScriptState({ loading: false, script: null, error: e.message });
    }
  };

  return (
    <div className="bg-[#13131f] border border-white/[0.07] rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-white/[0.06] flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-red-500/15 border border-red-500/20 flex items-center justify-center">
          <PlayCircle className="w-4 h-4 text-red-400" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">YouTube Video Concept</h2>
          <p className="text-[11px] text-slate-500">Pick a date range — AI finds the best video angle from that period</p>
        </div>
      </div>

      <div className="p-5 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 bg-[#0c0c18] border border-white/[0.07] rounded-xl px-3 py-2">
            <Calendar className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="bg-transparent outline-none text-sm text-slate-200 w-36" />
          </div>
          <span className="text-slate-600 text-xs">to</span>
          <div className="flex items-center gap-2 bg-[#0c0c18] border border-white/[0.07] rounded-xl px-3 py-2">
            <Calendar className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="bg-transparent outline-none text-sm text-slate-200 w-36" />
          </div>
          <button
            onClick={generate}
            disabled={loading || !dateFrom || !dateTo}
            className="flex items-center gap-2 bg-red-600 hover:bg-red-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm px-4 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-red-500/20"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {loading ? "Analyzing…" : "Find Best Concept"}
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 text-sm text-red-300 bg-red-500/[0.07] border border-red-500/15 rounded-xl px-4 py-3">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </div>
        )}

        {concept && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              AI recommends: <span className="text-white font-medium">{concept.recommendation === "synthesized" ? "Synthesized concept" : "Best single topic"}</span>
              {" — "}{concept.recommendation_reason}
            </p>

            {/* Option A */}
            <button
              onClick={() => setChosen("synthesized")}
              className={`w-full text-left p-4 rounded-xl border transition-all ${
                chosen === "synthesized" ? "border-red-500/40 bg-red-500/[0.07]" : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]"
              }`}
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider">Option A — Synthesized Concept</span>
                {concept.recommendation === "synthesized" && (
                  <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">AI Pick</span>
                )}
              </div>
              <p className="text-sm font-semibold text-white mb-1">{concept.synthesized.title}</p>
              <p className="text-[12px] text-slate-400 mb-2">{concept.synthesized.thesis}</p>
              <p className="text-[11px] text-slate-500 mb-2">{concept.synthesized.why}</p>
              {concept.synthesized.outline.length > 0 && (
                <div className="space-y-1">
                  {concept.synthesized.outline.map((o, i) => (
                    <div key={i} className="flex items-start gap-2 text-[11px]">
                      <span className="text-slate-600 shrink-0 font-mono">{i + 1}.</span>
                      <span className="text-slate-400"><span className="text-slate-300 font-medium">{o.section}</span> — {o.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </button>

            {/* Option B */}
            <button
              onClick={() => setChosen("best_single")}
              className={`w-full text-left p-4 rounded-xl border transition-all ${
                chosen === "best_single" ? "border-red-500/40 bg-red-500/[0.07]" : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]"
              }`}
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Option B — Best Single Topic Deep Dive</span>
                {concept.recommendation === "best_single" && (
                  <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">AI Pick</span>
                )}
              </div>
              {concept.best_single.update_id ? (
                <>
                  <p className="text-sm font-semibold text-white mb-1">{concept.best_single.title}</p>
                  <p className="text-[11px] text-slate-500">{concept.best_single.why}</p>
                </>
              ) : (
                <p className="text-[11px] text-slate-500 italic">No single topic stood out strongly enough for a standalone deep dive this period.</p>
              )}
            </button>

            {chosen && (
              <div className="pt-1">
                <button
                  onClick={generateScript}
                  disabled={scriptState.loading || (chosen === "best_single" && !concept.best_single.update_id)}
                  className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm px-4 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-500/20"
                >
                  {scriptState.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {scriptState.loading ? "Writing script…" : `Generate full script for Option ${chosen === "synthesized" ? "A" : "B"}`}
                  {!scriptState.loading && <ArrowRight className="w-3.5 h-3.5" />}
                </button>
                {scriptState.error && (
                  <p className="mt-2 text-xs text-red-300 flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {scriptState.error}
                  </p>
                )}
                {scriptState.script && <VideoScriptCard script={scriptState.script} />}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function SocialPage() {
  const [updates,     setUpdates]     = useState<Update[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [threshold,   setThreshold]   = useState(DEFAULT_THRESHOLD);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [rescoring,   setRescoring]   = useState(false);
  const [rescoreMsg,  setRescoreMsg]  = useState("");

  const fetchUpdates = useCallback(async () => {
    setLoading(true);
    const data = await getScoredUpdates();
    setUpdates(data as Update[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchUpdates(); }, [fetchUpdates]);

  // Override: save to DB then update local state so UI moves topic immediately
  const handleOverride = (id: string, platform: "instagram" | "youtube") => {
    setUpdates(prev => prev.map(u =>
      u.id === id ? { ...u, platform_override: platform } : u
    ));
  };

  // Re-score: send all analyzed topics through Phase 2 batch scoring again
  const handleRescore = async () => {
    setRescoring(true);
    setRescoreMsg("Fetching all analyzed topics…");
    try {
      const ids = await getAllAnalyzedUpdateIds();
      if (!ids.length) { setRescoreMsg("No analyzed topics found."); return; }
      setRescoreMsg(`Re-scoring ${ids.length} topics…`);
      const res = await fetch("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicIds: ids, force: false }),
      });
      if (!res.ok) throw new Error("Re-score request failed");
      setRescoreMsg("Done — refreshing scores…");
      await fetchUpdates();
      setRescoreMsg("");
    } catch (e: any) {
      setRescoreMsg("Re-score failed: " + e.message);
    } finally {
      setRescoring(false);
      setTimeout(() => setRescoreMsg(""), 4000);
    }
  };

  const shortlisted = updates.filter(u => {
    const score = u.social_score ?? 0;
    const platform = u.platform_override ?? u.recommended_platform;
    return (score >= threshold || !!u.platform_override) && platform !== "none";
  });

  const ignored = updates.filter(u => {
    const score = u.social_score ?? 0;
    const platform = u.platform_override ?? u.recommended_platform;
    return score < threshold && !u.platform_override && platform !== "none";
  });

  const noSignal = updates.filter(u => {
    const platform = u.platform_override ?? u.recommended_platform;
    return platform === "none" || platform === null;
  });

  return (
    <div className="space-y-6 animate-fade-up pb-10">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-2">
            <Clapperboard className="w-6 h-6 text-indigo-400" />
            Social
          </h1>
          <p className="text-slate-500 text-xs sm:text-sm mt-0.5">
            Instagram Reels and YouTube Videos — scored, filtered, scripted.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap self-start">
          {rescoreMsg && (
            <span className="text-xs text-indigo-300 flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> {rescoreMsg}
            </span>
          )}
          <button
            onClick={handleRescore}
            disabled={rescoring || loading}
            title="Re-run social scoring on all analyzed topics — useful if you added topics after the initial analysis"
            className="flex items-center gap-2 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 text-sm px-3 py-2 rounded-xl border border-white/[0.06] transition-all disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${rescoring ? "animate-spin" : ""}`} />
            Re-score All
          </button>
          <button
            onClick={fetchUpdates}
            disabled={loading}
            className="flex items-center gap-2 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 text-sm px-3 py-2 rounded-xl border border-white/[0.06] transition-all"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Threshold control */}
      <div className="bg-[#13131f] border border-white/[0.07] rounded-2xl px-5 py-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-medium text-slate-200">Shortlist threshold</span>
          </div>
          <span className="text-lg font-bold text-indigo-300 tabular-nums">{threshold.toFixed(1)}</span>
        </div>
        <input
          type="range" min="0" max="10" step="0.5" value={threshold}
          onChange={e => setThreshold(parseFloat(e.target.value))}
          className="w-full h-1.5 bg-white/[0.08] rounded-full appearance-none cursor-pointer accent-indigo-500"
        />
        <div className="flex justify-between text-[10px] text-slate-600 mt-1">
          <span>0 — show everything</span>
          <span>10 — only perfect picks</span>
        </div>
        <p className="text-[11px] text-slate-600 mt-2">
          {shortlisted.length} shortlisted · {ignored.length} in drawer · {noSignal.length} no signal
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16 gap-3 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading scored topics…</span>
        </div>
      )}

      {!loading && updates.length === 0 && (
        <div className="bg-[#13131f] border border-white/[0.06] rounded-2xl px-6 py-14 text-center">
          <Clapperboard className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <p className="text-slate-400 font-medium text-sm">No scored topics yet</p>
          <p className="text-slate-600 text-xs mt-1.5 max-w-xs mx-auto">
            Run Analytics on your topics first — social scoring happens automatically after analysis completes.
          </p>
        </div>
      )}

      {/* Shortlist */}
      {!loading && shortlisted.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">AI Shortlist</h2>
            <span className="text-xs text-slate-500">{shortlisted.length} topic{shortlisted.length !== 1 ? "s" : ""} above {threshold.toFixed(1)}</span>
          </div>
          {shortlisted.map(u => (
            <TopicRow key={u.id} update={u} isIgnored={false} onOverride={handleOverride} />
          ))}
        </div>
      )}

      {/* Ignored drawer */}
      {!loading && ignored.length > 0 && (
        <div className="bg-[#13131f] border border-white/[0.06] rounded-2xl overflow-hidden">
          <button
            onClick={() => setIgnoredOpen(v => !v)}
            className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-white/[0.02] transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-400">Ignored</span>
              <span className="text-xs text-slate-600 bg-white/[0.04] px-2 py-0.5 rounded border border-white/[0.05]">
                {ignored.length} below {threshold.toFixed(1)}
              </span>
            </div>
            {ignoredOpen ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
          </button>
          {ignoredOpen && (
            <div className="border-t border-white/[0.05] p-3 space-y-2">
              {ignored.map(u => (
                <TopicRow key={u.id} update={u} isIgnored={true} onOverride={handleOverride} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* YouTube concept tool */}
      {!loading && <YouTubeConceptPanel />}
    </div>
  );
}
