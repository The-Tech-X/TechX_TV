"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { getEpisodes, updateEpisodeScript, getTopicsForEpisodeRetry } from "../actions/episodes";
import { getUpdatesByEpisode } from "../actions/updates";
import { episodeStatus, episodeStatusLabel } from "../lib/episodeStatus";
import {
  Headphones, Save, RefreshCw, Loader2, Mic, FileText,
  Volume2, CheckCircle2, Clock, AlignLeft, Link2, ListMusic, ChevronLeft,
  AlertCircle, Sparkles, ArrowRight, Brain
} from "lucide-react";

export default function ScriptStudioPage() {
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [selectedEpisode, setSelectedEpisode] = useState<any | null>(null);
  const [scriptText, setScriptText] = useState("");
  const [linkedTopics, setLinkedTopics] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [audioStatus, setAudioStatus] = useState("");
  const [episodeListOpen, setEpisodeListOpen] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryStatus, setRetryStatus] = useState("");

  useEffect(() => { loadEpisodes(); }, []);

  // Lock body scroll when mobile episode list is open
  useEffect(() => {
    if (episodeListOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = prev; };
    }
  }, [episodeListOpen]);

  const loadEpisodes = async () => {
    setIsLoading(true);
    setEpisodes(await getEpisodes());
    setIsLoading(false);
  };

  const handleSelectEpisode = async (ep: any) => {
    setSelectedEpisode(ep);
    setScriptText(ep.script_text || "");
    setSaveSuccess(false);
    setAudioStatus("");
    setRetryStatus("");
    setEpisodeListOpen(false);
    const topics = await getUpdatesByEpisode(ep.id);
    setLinkedTopics(topics);
  };

  // Re-fire /api/analyze for an episode whose initial run failed or timed out.
  // We pull topic_ids out of the episode's analysis_json (written when the
  // first attempt started) and resubmit them.
  const handleRetryScript = async () => {
    if (!selectedEpisode) return;
    setIsRetrying(true);
    setRetryStatus("Fetching original topics…");
    try {
      const { topics, language } = await getTopicsForEpisodeRetry(selectedEpisode.week_id);
      if (!topics.length) {
        setRetryStatus("Couldn't find the source topics for this episode. Re-create it from Topic Discovery.");
        setTimeout(() => { setIsRetrying(false); setRetryStatus(""); }, 5000);
        return;
      }

      const payloadTopics = topics.map((t: any) => ({
        id: t.id,
        title: t.title,
        source: t.source,
        content: t.content,
        analysis_json: t.analysis_json,
      }));

      setRetryStatus("Re-sending briefs to the script writer…");
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId: selectedEpisode.week_id, topics: payloadTopics, language }),
      });
      if (!res.ok) throw new Error("Failed to restart script generation");

      setRetryStatus("Generating podcast script…");
      let attempts = 0;
      let done = false;
      while (!done && attempts < 60) {
        await new Promise(r => setTimeout(r, 4000));
        attempts++;
        setRetryStatus(`Generating podcast script… (${attempts * 4}s elapsed)`);
        const eps = await getEpisodes();
        const refreshed = eps.find((e: any) => e.id === selectedEpisode.id);
        if (refreshed?.script_text) {
          done = true;
          setEpisodes(eps);
          setSelectedEpisode(refreshed);
          setScriptText(refreshed.script_text);
        } else if (refreshed?.analysis_json?.error) {
          throw new Error(refreshed.analysis_json.error);
        }
      }

      if (done) {
        setRetryStatus("Script ready.");
        setTimeout(() => setRetryStatus(""), 3000);
      } else {
        setRetryStatus("Still processing in background — refresh in a minute.");
      }
    } catch (e: any) {
      setRetryStatus(`Error: ${e.message}`);
    } finally {
      setTimeout(() => setIsRetrying(false), 1500);
    }
  };

  const handleSave = async () => {
    if (!selectedEpisode) return;
    setIsSaving(true);
    try {
      const updated = await updateEpisodeScript(selectedEpisode.id, scriptText);
      setEpisodes(prev => prev.map(e => e.id === updated.id ? updated : e));
      setSelectedEpisode(updated);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch {
      alert("Save failed. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleGenerateAudio = async () => {
    if (!selectedEpisode || !scriptText.trim()) return;
    setIsGeneratingAudio(true);
    setAudioStatus("Generating audio...");
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: scriptText, episodeId: selectedEpisode.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const updatedEp = { ...selectedEpisode, audio_url: data.audio_url };
      setSelectedEpisode(updatedEp);
      setEpisodes(prev => prev.map(e => e.id === updatedEp.id ? updatedEp : e));
      setAudioStatus("Audio ready!");
      setTimeout(() => setAudioStatus(""), 3000);
    } catch (err: any) {
      setAudioStatus("");
      alert("Audio generation failed: " + err.message + "\n\n(Make sure you have an 'audio' bucket in Supabase Storage.)");
    } finally {
      setIsGeneratingAudio(false);
    }
  };

  const wordCount  = scriptText.split(/\s+/).filter(Boolean).length;
  const charCount  = scriptText.length;
  const estMinutes = Math.max(1, Math.round(wordCount / 130));

  const EpisodeList = (
    <>
      <div className="px-4 py-3 border-b border-white/[0.06] bg-white/[0.01] flex items-center justify-between">
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">All Episodes</h2>
        <button
          type="button"
          aria-label="Close list"
          onClick={() => setEpisodeListOpen(false)}
          className="md:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.05] transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex justify-center py-10">
            <Loader2 className="w-5 h-5 text-slate-700 animate-spin" />
          </div>
        )}
        {!isLoading && episodes.length === 0 && (
          <div className="px-4 py-10 text-center text-slate-600 text-xs leading-relaxed">
            No episodes yet.<br />Go to Topic Discovery to create one.
          </div>
        )}
        {episodes.map(ep => {
          const status = episodeStatus(ep);
          return (
          <button
            key={ep.id}
            onClick={() => handleSelectEpisode(ep)}
            className={`w-full text-left px-4 py-3.5 border-b border-white/[0.04] hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors relative group ${
              selectedEpisode?.id === ep.id ? "bg-indigo-500/[0.07]" : ""
            }`}
          >
            {selectedEpisode?.id === ep.id && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-indigo-400 rounded-full" />
            )}
            <div className={`text-sm font-medium truncate ${selectedEpisode?.id === ep.id ? "text-white" : "text-slate-300"}`}>
              {ep.week_id}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[11px] text-slate-600">
                {new Date(ep.created_at).toLocaleDateString()}
              </span>
              {status === "generating" && (
                <span className="text-[10px] text-amber-400/90 flex items-center gap-1">
                  <Loader2 className="w-2.5 h-2.5 animate-spin" /> Generating
                </span>
              )}
              {status === "failed" && (
                <span className="text-[10px] text-red-400/90 flex items-center gap-1">
                  <AlertCircle className="w-2.5 h-2.5" /> Failed
                </span>
              )}
              {ep.audio_url && <Volume2 className="w-3 h-3 text-emerald-600 ml-auto" />}
            </div>
          </button>
        );
        })}
      </div>
    </>
  );

  return (
    <div className="min-h-[calc(100svh-3.5rem-2.5rem)] md:h-[calc(100vh-4rem)] flex flex-col gap-4 sm:gap-5 animate-fade-up">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-white">Script Studio</h1>
          <p className="text-slate-500 text-xs sm:text-sm mt-0.5">Edit AI-generated scripts and synthesize podcast audio.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setEpisodeListOpen(true)}
            title="Episodes"
            aria-label="Open episodes list"
            className="md:hidden p-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] active:bg-white/[0.12] text-slate-400 hover:text-white transition-all border border-white/[0.06]"
          >
            <ListMusic className="w-4 h-4" />
          </button>
          <button
            onClick={loadEpisodes}
            title="Refresh episodes"
            aria-label="Refresh episodes"
            className="p-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] active:bg-white/[0.12] text-slate-400 hover:text-white transition-all border border-white/[0.06]"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="flex gap-5 flex-1 md:overflow-hidden min-h-0">
        {/* Episodes sidebar — desktop */}
        <div className="hidden md:flex w-56 bg-[#13131f] border border-white/[0.06] rounded-2xl flex-col overflow-hidden shrink-0">
          {EpisodeList}
        </div>

        {/* Episodes drawer — mobile */}
        {episodeListOpen && (
          <div className="md:hidden fixed inset-0 z-[60] flex animate-fade-in" onClick={() => setEpisodeListOpen(false)}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
              className="relative w-72 max-w-[85vw] bg-[#13131f] border-r border-white/[0.06] flex flex-col animate-slide-right"
              onClick={e => e.stopPropagation()}
            >
              {EpisodeList}
            </div>
          </div>
        )}

        {/* Editor pane */}
        {selectedEpisode ? (
          <div className="flex-1 flex flex-col gap-3 sm:gap-4 md:overflow-hidden min-w-0">
            {/* Toolbar */}
            <div className="bg-[#13131f] border border-white/[0.06] rounded-2xl px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-3 shrink-0 flex-wrap">
              <span className="bg-indigo-500/15 text-indigo-300 text-xs font-bold px-2.5 sm:px-3 py-1 rounded-lg border border-indigo-500/20">
                {selectedEpisode.week_id}
              </span>

              <div className="flex items-center gap-2 sm:gap-3 text-[11px] sm:text-xs text-slate-600 flex-wrap">
                <span className="flex items-center gap-1"><AlignLeft className="w-3 h-3" />{wordCount.toLocaleString()}w</span>
                <span className="hidden sm:inline">{charCount.toLocaleString()} chars</span>
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" />~{estMinutes}m</span>
                {linkedTopics.length > 0 && (
                  <span className="flex items-center gap-1 text-indigo-500/70">
                    <Link2 className="w-3 h-3" />{linkedTopics.length} topics
                  </span>
                )}
              </div>

              {selectedEpisode.audio_url && (
                <audio controls src={selectedEpisode.audio_url} className="h-8 w-full sm:w-auto sm:max-w-[220px] outline-none order-last sm:order-none basis-full sm:basis-auto" />
              )}

              <div className="ml-auto flex items-center gap-2 flex-wrap">
                {audioStatus && (
                  <span className="text-[11px] sm:text-xs text-indigo-300 animate-fade-in w-full sm:w-auto">{audioStatus}</span>
                )}
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex items-center gap-1.5 bg-white/[0.05] hover:bg-white/[0.09] active:bg-white/[0.13] text-slate-200 text-sm px-3 sm:px-3.5 py-2 sm:py-1.5 rounded-xl font-medium transition-all border border-white/[0.07] disabled:opacity-50"
                >
                  {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : saveSuccess ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    : <Save className="w-3.5 h-3.5" />}
                  {saveSuccess ? "Saved!" : "Save"}
                </button>
                <button
                  onClick={handleGenerateAudio}
                  disabled={isGeneratingAudio || !scriptText.trim()}
                  className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm px-3.5 sm:px-4 py-2 sm:py-1.5 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-500/20"
                >
                  {isGeneratingAudio ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5" />}
                  {isGeneratingAudio ? "Generating..." : "Generate Audio"}
                </button>
              </div>
            </div>

            {/* Status banner — only shown when we don't have a finished script yet */}
            {(() => {
              const status = episodeStatus(selectedEpisode);
              if (status === "ready") return null;
              const isFailed = status === "failed";
              const isGenerating = status === "generating";
              const errMsg = selectedEpisode.analysis_json?.error;
              return (
                <div className={`rounded-2xl border px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 ${
                  isFailed
                    ? "bg-red-500/[0.06] border-red-500/20"
                    : isGenerating
                      ? "bg-amber-500/[0.06] border-amber-500/20"
                      : "bg-white/[0.02] border-white/[0.07]"
                }`}>
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    {isFailed
                      ? <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                      : isGenerating
                        ? <Loader2 className="w-5 h-5 text-amber-400 animate-spin shrink-0 mt-0.5" />
                        : <FileText className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />}
                    <div className="min-w-0">
                      <div className={`text-sm font-semibold ${isFailed ? "text-red-300" : isGenerating ? "text-amber-300" : "text-slate-300"}`}>
                        {episodeStatusLabel(status)}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {isFailed && (errMsg
                          ? `Script generation failed: ${errMsg}`
                          : "Script generation failed. Try again or open Analytics to edit the briefs.")}
                        {isGenerating && "Script generation is running in the background. Refresh to check progress."}
                        {status === "pending" && "No script yet. Generate one from the Analytics page."}
                      </div>
                      {retryStatus && (
                        <div className="text-xs text-indigo-300 mt-1.5 flex items-center gap-1.5">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          {retryStatus}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Link
                      href={`/analytics?episode=${encodeURIComponent(selectedEpisode.week_id)}&lang=${selectedEpisode.analysis_json?.language === "tenglish" ? "tenglish" : "english"}`}
                      className="flex items-center gap-1.5 bg-white/[0.05] hover:bg-white/[0.09] text-slate-200 text-xs px-3 py-2 rounded-xl font-medium border border-white/[0.07] transition-all"
                    >
                      <Brain className="w-3.5 h-3.5" />
                      Open Analytics
                      <ArrowRight className="w-3 h-3 opacity-70" />
                    </Link>
                    {(isFailed || isGenerating) && Array.isArray(selectedEpisode.analysis_json?.topic_ids) && selectedEpisode.analysis_json.topic_ids.length > 0 && (
                      <button
                        onClick={handleRetryScript}
                        disabled={isRetrying}
                        className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs px-3 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-500/20"
                      >
                        {isRetrying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                        {isRetrying ? "Retrying…" : "Retry script"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Script textarea */}
            <div className="flex-1 bg-[#13131f] border border-white/[0.06] rounded-2xl overflow-hidden flex flex-col min-h-[55vh] md:min-h-0">
              <div className="px-4 sm:px-5 py-2.5 border-b border-white/[0.05] bg-white/[0.01] flex items-center gap-2 shrink-0">
                <FileText className="w-3.5 h-3.5 text-slate-600" />
                <span className="text-xs text-slate-500 font-medium">Podcast Script</span>
                <span className="ml-auto text-[10px] sm:text-[11px] text-slate-700 truncate">en-US-AndrewNeural</span>
              </div>
              <textarea
                value={scriptText}
                onChange={e => setScriptText(e.target.value)}
                spellCheck={false}
                className="flex-1 bg-transparent px-4 sm:px-6 py-4 sm:py-5 text-[14px] sm:text-[15px] text-slate-200 leading-[1.8] sm:leading-[1.9] focus:outline-none resize-none min-h-[300px] md:min-h-0 font-[system-ui,sans-serif]"
                placeholder="Your podcast script will appear here after generating an episode. You can also write or edit it manually..."
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-[#13131f] border border-white/[0.06] rounded-2xl min-h-[40vh]">
            <div className="text-center space-y-3 px-6">
              <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.07] flex items-center justify-center mx-auto">
                <Headphones className="w-6 h-6 text-slate-700" />
              </div>
              <div>
                <p className="text-slate-400 font-medium text-sm">Select an episode</p>
                <p className="text-slate-600 text-xs mt-1">
                  <span className="md:hidden">Tap the list icon above to pick one.</span>
                  <span className="hidden md:inline">The script will load here for editing.</span>
                </p>
              </div>
              {episodes.length > 0 && (
                <button
                  onClick={() => setEpisodeListOpen(true)}
                  className="md:hidden inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-sm px-4 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-500/20"
                >
                  <ListMusic className="w-4 h-4" />
                  Browse episodes
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
