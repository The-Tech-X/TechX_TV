"use client";

import { useState, useEffect } from "react";
import { getEpisodes, updateEpisodeScript } from "../actions/episodes";
import { getUpdatesByEpisode } from "../actions/updates";
import {
  Headphones, Save, RefreshCw, Loader2, Mic, FileText,
  Volume2, CheckCircle2, Clock, AlignLeft, Link2
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

  useEffect(() => { loadEpisodes(); }, []);

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
    const topics = await getUpdatesByEpisode(ep.id);
    setLinkedTopics(topics);
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

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col gap-5 animate-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-white">Script Studio</h1>
          <p className="text-slate-500 text-sm mt-0.5">Edit AI-generated scripts and synthesize podcast audio.</p>
        </div>
        <button
          onClick={loadEpisodes}
          title="Refresh episodes"
          className="p-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white transition-all border border-white/[0.06]"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="flex gap-5 flex-1 overflow-hidden min-h-0">
        {/* Episodes sidebar */}
        <div className="w-56 bg-[#13131f] border border-white/[0.06] rounded-2xl flex flex-col overflow-hidden shrink-0">
          <div className="px-4 py-3 border-b border-white/[0.06] bg-white/[0.01]">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">All Episodes</h2>
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
            {episodes.map(ep => (
              <button
                key={ep.id}
                onClick={() => handleSelectEpisode(ep)}
                className={`w-full text-left px-4 py-3.5 border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors relative group ${
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
                  {ep.audio_url && <Volume2 className="w-3 h-3 text-emerald-600 ml-auto" />}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Editor pane */}
        {selectedEpisode ? (
          <div className="flex-1 flex flex-col gap-4 overflow-hidden min-w-0">
            {/* Toolbar */}
            <div className="bg-[#13131f] border border-white/[0.06] rounded-2xl px-4 py-3 flex items-center gap-3 shrink-0 flex-wrap">
              <span className="bg-indigo-500/15 text-indigo-300 text-xs font-bold px-3 py-1 rounded-lg border border-indigo-500/20">
                {selectedEpisode.week_id}
              </span>

              <div className="flex items-center gap-3 text-xs text-slate-600">
                <span className="flex items-center gap-1"><AlignLeft className="w-3 h-3" />{wordCount.toLocaleString()} words</span>
                <span>{charCount.toLocaleString()} chars</span>
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" />~{estMinutes} min</span>
                {linkedTopics.length > 0 && (
                  <span className="flex items-center gap-1 text-indigo-500/70">
                    <Link2 className="w-3 h-3" />{linkedTopics.length} topics linked
                  </span>
                )}
              </div>

              {selectedEpisode.audio_url && (
                <audio controls src={selectedEpisode.audio_url} className="h-8 max-w-[220px] outline-none ml-1" />
              )}

              <div className="ml-auto flex items-center gap-2">
                {audioStatus && (
                  <span className="text-xs text-indigo-300 animate-fade-in">{audioStatus}</span>
                )}
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex items-center gap-1.5 bg-white/[0.05] hover:bg-white/[0.09] text-slate-200 text-sm px-3.5 py-1.5 rounded-xl font-medium transition-all border border-white/[0.07] disabled:opacity-50"
                >
                  {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : saveSuccess ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    : <Save className="w-3.5 h-3.5" />}
                  {saveSuccess ? "Saved!" : "Save"}
                </button>
                <button
                  onClick={handleGenerateAudio}
                  disabled={isGeneratingAudio || !scriptText.trim()}
                  className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm px-4 py-1.5 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-500/20"
                >
                  {isGeneratingAudio ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5" />}
                  {isGeneratingAudio ? "Generating..." : "Generate Audio"}
                </button>
              </div>
            </div>

            {/* Script textarea */}
            <div className="flex-1 bg-[#13131f] border border-white/[0.06] rounded-2xl overflow-hidden flex flex-col min-h-0">
              <div className="px-5 py-2.5 border-b border-white/[0.05] bg-white/[0.01] flex items-center gap-2 shrink-0">
                <FileText className="w-3.5 h-3.5 text-slate-600" />
                <span className="text-xs text-slate-500 font-medium">Podcast Script</span>
                <span className="ml-auto text-[11px] text-slate-700">en-US-AndrewNeural</span>
              </div>
              <textarea
                value={scriptText}
                onChange={e => setScriptText(e.target.value)}
                spellCheck={false}
                className="flex-1 bg-transparent px-6 py-5 text-[15px] text-slate-200 leading-[1.9] focus:outline-none resize-none min-h-0 font-[system-ui,sans-serif]"
                placeholder="Your podcast script will appear here after generating an episode. You can also write or edit it manually..."
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-[#13131f] border border-white/[0.06] rounded-2xl">
            <div className="text-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.07] flex items-center justify-center mx-auto">
                <Headphones className="w-6 h-6 text-slate-700" />
              </div>
              <div>
                <p className="text-slate-400 font-medium text-sm">Select an episode</p>
                <p className="text-slate-600 text-xs mt-1">The script will load here for editing.</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
