"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, ExternalLink, Loader2, Sparkles, Copy, CheckCircle2,
  Save, RefreshCw, Lightbulb, Compass, Eye, Brain, Globe, Film, Headphones,
} from "lucide-react";
import { getUpdateById, updateTopicAnalysis, type TopicAnalysis } from "../../actions/updates";
import { getSocialScriptsForUpdate } from "../../actions/social";
import { Field, KeyFactsField } from "../../components/BriefFields";
import { progressStepText } from "../../lib/analysisProgress";

const EMPTY: TopicAnalysis = {
  summary: "", whyNow: "", keyFacts: [], biggerPicture: "", honestTake: "", sources: [],
};

function asAnalysis(raw: any): TopicAnalysis {
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  return {
    summary:        String(raw.summary        || "").trim(),
    whyNow:         String(raw.whyNow          || "").trim(),
    keyFacts:       Array.isArray(raw.keyFacts) ? raw.keyFacts.map(String) : [],
    biggerPicture:  String(raw.biggerPicture   || "").trim(),
    honestTake:     String(raw.honestTake      || "").trim(),
    sources:        Array.isArray(raw.sources) ? raw.sources : [],
  };
}

type QuickPlatform = "linkedin" | "whatsapp" | "x";

const QUICK_PLATFORMS: { key: QuickPlatform; label: string; charLimit?: number }[] = [
  { key: "linkedin", label: "LinkedIn" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "x",        label: "X",        charLimit: 280 },
];

function formatReelVideoScript(platform: "instagram" | "youtube", script: any): string {
  if (!script) return "";
  if (platform === "instagram") {
    const bullets = Array.isArray(script.bullets) ? script.bullets.map((b: string) => `• ${b}`).join("\n") : "";
    return `${script.hook || ""}\n\n${bullets}\n\n${script.cta || ""}`.trim();
  }
  const sections = Array.isArray(script.sections)
    ? script.sections.map((s: any) => `${s.title}\n${(s.points || []).map((p: string) => `- ${p}`).join("\n")}`).join("\n\n")
    : "";
  return `${script.hook || ""}\n\n${sections}\n\n${script.conclusion || ""}`.trim();
}

export default function TopicWorkspacePage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();

  const [topic, setTopic] = useState<any | null>(null);
  const [analysis, setAnalysis] = useState<TopicAnalysis>(EMPTY);
  const [scripts, setScripts] = useState<Record<string, { content?: string; note?: string | null; script_json?: any }>>({});
  const [pageStatus, setPageStatus] = useState<"loading" | "ready" | "not-found">("loading");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const [progress, setProgress] = useState<any | null>(null);

  const load = useCallback(async () => {
    const [t, socialScripts] = await Promise.all([
      getUpdateById(id),
      getSocialScriptsForUpdate(id),
    ]);
    if (!t) { setPageStatus("not-found"); return; }
    setTopic(t);
    setAnalysis(asAnalysis(t.analysis_json));
    const map: Record<string, { content?: string; note?: string | null; script_json?: any }> = {};
    for (const row of socialScripts) {
      map[row.platform] = { content: row.script_json?.content, note: row.note, script_json: row.script_json };
    }
    setScripts(map);
    setPageStatus("ready");
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Live progress + settlement: while a (re-)analysis is in flight, poll the
  // DB directly for the step/sources AND for the real outcome. This is the
  // single source of truth for done/failed — independent of whether the
  // fetch in handleRetryAnalysis is still connected, because a dropped
  // client connection ("Failed to fetch") does not stop the server-side
  // work. Relying on that fetch alone to decide success/failure would show
  // false failures whenever the connection drops before the (potentially
  // multi-minute) analysis finishes.
  const isAnalyzing = retrying || (pageStatus === "ready" && !topic?.analysis_json);
  useEffect(() => {
    if (!isAnalyzing) return;
    let cancelled = false;
    let settled = false;
    const poll = async () => {
      if (settled) return;
      let t: any;
      try {
        t = await getUpdateById(id);
      } catch (e) {
        console.warn("[Topic] Progress poll failed, will retry", e);
        return;
      }
      if (cancelled || !t) return;
      if (t.analysis_json) {
        settled = true;
        setTopic(t);
        setAnalysis(asAnalysis(t.analysis_json));
        setProgress(null);
        setRetrying(false);
        setRetryError("");
        return;
      }
      if (t.analysis_progress?.step === "failed") {
        settled = true;
        setProgress(t.analysis_progress);
        setRetrying(false);
        setRetryError(t.analysis_progress.error || "Analysis failed");
        return;
      }
      setProgress(t.analysis_progress || null);
    };
    poll();
    const interval = setInterval(poll, 2500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isAnalyzing, id]);

  const handleSaveBrief = async () => {
    setSaving(true);
    try {
      await updateTopicAnalysis(id, analysis);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleRetryAnalysis = async () => {
    setRetrying(true);
    setRetryError("");
    setProgress(null);

    let res: Response;
    try {
      res = await fetch("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicIds: [id], force: true, skipScoring: true }),
      });
    } catch (e: any) {
      // Network-level failure — the connection to our own API dropped, but
      // the server keeps working independently. Don't show a false error or
      // clear the spinner; the progress poller above discovers the real
      // outcome (done or a persisted failure) once the server finishes.
      console.warn("[Topic] Connection to /api/analytics dropped — relying on progress polling.", e);
      return;
    }

    try {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      const result = data.results?.[0];
      if (result?.error) throw new Error(result.error);
      await load();
      setRetrying(false);
    } catch (e: any) {
      setRetryError(e.message || "Analysis failed");
      setRetrying(false);
    }
  };

  if (pageStatus === "loading") {
    return (
      <div className="flex items-center justify-center h-64 gap-3 text-neutral-500">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading topic…</span>
      </div>
    );
  }

  if (pageStatus === "not-found") {
    return (
      <div className="text-center py-20">
        <p className="text-neutral-500 text-sm">Topic not found.</p>
        <button onClick={() => router.push("/")} className="mt-3 text-red-600 text-sm font-medium hover:underline">
          Back to Dashboard
        </button>
      </div>
    );
  }

  const hasAnalysis = !!topic.analysis_json;
  // Quick Posts (LinkedIn/WhatsApp/X) run on Gemini directly against the
  // scraped sources — that's written as soon as the web search succeeds,
  // well before the (slower) Mistral brief that hasAnalysis tracks. Gating
  // Quick Posts on hasAnalysis would make users wait on the slow call for
  // no reason, defeating the point of moving these platforms off it.
  const hasScrapedContent = Array.isArray(topic.scraped_content) && topic.scraped_content.length > 0;

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-up">
      {/* Header */}
      <div>
        <button
          onClick={() => router.push("/")}
          className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-black transition-colors mb-3"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Dashboard
        </button>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-black leading-snug">{topic.title}</h1>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="text-[11px] text-neutral-500 bg-black/[0.04] px-2 py-0.5 rounded border border-black/[0.07]">
              {topic.source || "Unknown source"}
            </span>
            {topic.url && (
              <a
                href={topic.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-red-600 transition-colors"
              >
                <ExternalLink className="w-3 h-3" /> View original
              </a>
            )}
            {topic.social_score != null && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-red-500/10 text-red-600 border border-red-500/20">
                {topic.recommended_platform === "instagram" ? "Reel" : topic.recommended_platform === "youtube" ? "Video" : "No pick"} · {Number(topic.social_score).toFixed(1)}
              </span>
            )}
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded-md border flex items-center gap-1 ${
              topic.episode_id
                ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                : "bg-black/[0.03] text-neutral-400 border-black/[0.07]"
            }`}>
              <Headphones className="w-3 h-3" />
              {topic.episode_id ? "In a podcast episode" : "Not in a podcast yet"}
            </span>
          </div>
        </div>
      </div>

      {/* Research brief */}
      <div className="bg-white border border-black/[0.08] rounded-2xl overflow-hidden card-glow">
        <div className="px-4 sm:px-5 py-3.5 border-b border-black/[0.07] bg-black/[0.01] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-800 flex items-center gap-2">
            <Brain className="w-4 h-4 text-red-600" /> Research Brief
          </h2>
          {hasAnalysis && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleRetryAnalysis}
                disabled={retrying}
                className="flex items-center gap-1.5 bg-black/[0.04] hover:bg-black/[0.08] disabled:opacity-40 text-neutral-800 text-xs px-2.5 py-1.5 rounded-lg border border-black/[0.08] transition-all"
              >
                {retrying ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Re-analyze
              </button>
              <button
                onClick={handleSaveBrief}
                disabled={saving}
                className="flex items-center gap-1.5 bg-black/[0.04] hover:bg-black/[0.08] disabled:opacity-40 text-neutral-800 text-xs px-2.5 py-1.5 rounded-lg border border-black/[0.08] transition-all"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <Save className="w-3 h-3" />}
                {saved ? "Saved" : "Save"}
              </button>
            </div>
          )}
        </div>

        {hasAnalysis && retrying && (
          <div className="px-4 sm:px-5 py-2 border-b border-black/[0.07] bg-black/[0.015] flex items-center gap-2 text-[11px] text-neutral-500">
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            <span>{progressStepText(progress)}</span>
            {progress?.sources?.length > 0 && (
              <span className="text-neutral-400">— {progress.sources.length} source{progress.sources.length === 1 ? "" : "s"} found</span>
            )}
          </div>
        )}

        {!hasAnalysis ? (
          <div className="px-5 py-8 text-center">
            <Loader2 className="w-5 h-5 text-neutral-400 animate-spin mx-auto mb-2" />
            <p className="text-sm text-neutral-500">{progressStepText(progress)}</p>
            {progress?.sources && progress.sources.length > 0 && (
              <div className="flex flex-wrap gap-1.5 justify-center mt-3 max-w-md mx-auto">
                {progress.sources.map((s: any, i: number) => (
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
            {progress?.step === "failed" && progress?.error && (
              <p className="text-xs text-red-600 mt-3">{progress.error}</p>
            )}
            {retryError && <p className="text-xs text-red-600 mt-2">{retryError}</p>}
            <button
              onClick={handleRetryAnalysis}
              disabled={retrying}
              className="mt-3 text-xs text-red-600 font-medium hover:underline disabled:opacity-40"
            >
              {retrying ? "Retrying…" : "Retry now"}
            </button>
          </div>
        ) : (
          <div className="p-4 sm:p-5 space-y-4">
            <Field
              icon={<Lightbulb className="w-3.5 h-3.5" />}
              label="Summary"
              hint="What actually happened, in plain English."
              value={analysis.summary}
              onChange={v => setAnalysis(a => ({ ...a, summary: v }))}
              rows={3}
            />
            <Field
              icon={<Compass className="w-3.5 h-3.5" />}
              label="Why now"
              hint="The catalyst — what pressure, competition, or opportunity drove this now?"
              value={analysis.whyNow}
              onChange={v => setAnalysis(a => ({ ...a, whyNow: v }))}
              rows={3}
            />
            <KeyFactsField
              facts={analysis.keyFacts}
              onChange={facts => setAnalysis(a => ({ ...a, keyFacts: facts }))}
            />
            <Field
              icon={<Eye className="w-3.5 h-3.5" />}
              label="Bigger picture"
              hint="What this means for the industry / consumers / people working in tech."
              value={analysis.biggerPicture}
              onChange={v => setAnalysis(a => ({ ...a, biggerPicture: v }))}
              rows={3}
            />
            <Field
              icon={<Brain className="w-3.5 h-3.5" />}
              label="Honest take"
              hint="Is this a big deal, hype, or complicated? Commit to a view."
              value={analysis.honestTake}
              onChange={v => setAnalysis(a => ({ ...a, honestTake: v }))}
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

      {/* Quick Posts — primary: LinkedIn, WhatsApp, X. Used every topic. */}
      {hasScrapedContent && (
        <div>
          <h2 className="text-sm font-semibold text-black mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-red-600" /> Quick Posts
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {QUICK_PLATFORMS.map(p => (
              <QuickPostCard
                key={p.key}
                platform={p.key}
                label={p.label}
                updateId={id}
                existing={scripts[p.key]}
                charLimit={p.charLimit}
              />
            ))}
          </div>
        </div>
      )}

      {/* Reel & Video — secondary: occasional, AI-scored, not every topic. */}
      {hasAnalysis && (
        <div>
          <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Film className="w-3.5 h-3.5" /> Reel & Video
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ReelVideoCard platform="instagram" label="Instagram Reel" updateId={id} existing={scripts["instagram"]} />
            <ReelVideoCard platform="youtube" label="YouTube Video" updateId={id} existing={scripts["youtube"]} />
          </div>
        </div>
      )}
    </div>
  );
}

function QuickPostCard({
  platform, label, updateId, existing, charLimit,
}: {
  platform: QuickPlatform;
  label: string;
  updateId: string;
  existing?: { content?: string; note?: string | null };
  charLimit?: number;
}) {
  const [note, setNote] = useState(existing?.note || "");
  const [content, setContent] = useState(existing?.content || "");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/social-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updateId, platform, note: note.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Generation failed");
      setContent(data.script?.content || "");
    } catch (e: any) {
      setError(e.message || "Generation failed");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const overLimit = !!charLimit && content.length > charLimit;

  return (
    <div className="bg-white border border-black/[0.08] rounded-2xl p-4 card-glow flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-black">{label}</h3>
        {charLimit && content && (
          <span className={`text-[11px] font-medium tabular-nums ${overLimit ? "text-red-600" : "text-neutral-400"}`}>
            {content.length}/{charLimit}
          </span>
        )}
      </div>
      <input
        type="text"
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="Optional angle or emphasis…"
        className="w-full bg-[#f5f5f5] border border-black/[0.08] rounded-lg px-3 py-2 text-xs text-neutral-900 placeholder-neutral-400 outline-none focus:border-red-500/40 transition-colors"
      />
      <button
        onClick={handleGenerate}
        disabled={isGenerating}
        className="flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-500 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-xs px-3 py-2 rounded-xl font-semibold shadow-lg shadow-red-500/20 transition-all"
      >
        {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
        {isGenerating ? "Generating…" : content ? "Regenerate" : "Generate"}
      </button>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      {content && (
        <>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={7}
            className="w-full bg-[#f5f5f5] border border-black/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-neutral-900 leading-relaxed outline-none focus:border-red-500/40 transition-colors resize-y"
          />
          <button
            onClick={handleCopy}
            className="flex items-center justify-center gap-1.5 bg-black/[0.04] hover:bg-black/[0.08] text-neutral-800 text-xs px-3 py-2 rounded-lg border border-black/[0.08] transition-all"
          >
            {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </>
      )}
    </div>
  );
}

function ReelVideoCard({
  platform, label, updateId, existing,
}: {
  platform: "instagram" | "youtube";
  label: string;
  updateId: string;
  existing?: { script_json?: any };
}) {
  const [content, setContent] = useState(() => formatReelVideoScript(platform, existing?.script_json));
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/social-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updateId, platform }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Generation failed");
      setContent(formatReelVideoScript(platform, data.script));
    } catch (e: any) {
      setError(e.message || "Generation failed");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="bg-white border border-black/[0.08] rounded-2xl p-4 card-glow flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-black">{label}</h3>
      <button
        onClick={handleGenerate}
        disabled={isGenerating}
        className="flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-500 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-xs px-3 py-2 rounded-xl font-semibold shadow-lg shadow-red-500/20 transition-all"
      >
        {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
        {isGenerating ? "Generating…" : content ? "Regenerate" : "Generate"}
      </button>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      {content && (
        <>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={8}
            className="w-full bg-[#f5f5f5] border border-black/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-neutral-900 leading-relaxed outline-none focus:border-red-500/40 transition-colors resize-y"
          />
          <button
            onClick={handleCopy}
            className="flex items-center justify-center gap-1.5 bg-black/[0.04] hover:bg-black/[0.08] text-neutral-800 text-xs px-3 py-2 rounded-lg border border-black/[0.08] transition-all"
          >
            {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </>
      )}
    </div>
  );
}
