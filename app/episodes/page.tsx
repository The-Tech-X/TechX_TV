"use client";

import { useEffect, useState } from "react";
import { getEpisodes } from "../actions/episodes";
import { getUpdatesByEpisode } from "../actions/updates";
import { Headphones, Loader2, Calendar, Volume2, FileText, Clock, Tag, ChevronDown, ChevronUp } from "lucide-react";

function EpisodeCard({ ep }: { ep: any }) {
  const [linkedTopics, setLinkedTopics] = useState<any[]>([]);
  const [showTopics, setShowTopics] = useState(false);

  const wordCount = ep.script_text ? ep.script_text.split(/\s+/).filter(Boolean).length : 0;
  const estMin    = Math.max(1, Math.round(wordCount / 130));
  const preview   = ep.script_text ? ep.script_text.substring(0, 180).trim() + "…" : null;

  const handleToggleTopics = async () => {
    if (!showTopics && linkedTopics.length === 0) {
      const topics = await getUpdatesByEpisode(ep.id);
      setLinkedTopics(topics);
    }
    setShowTopics(v => !v);
  };

  return (
    <div className="bg-[#13131f] border border-white/[0.06] rounded-2xl flex flex-col card-glow overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-white/[0.05] flex items-center justify-between bg-white/[0.01]">
        <span className="text-xs font-bold text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-2.5 py-1 rounded-lg">
          {ep.week_id}
        </span>
        <div className="flex items-center gap-3">
          {ep.audio_url && (
            <span className="flex items-center gap-1 text-emerald-500 text-[11px] font-medium">
              <Volume2 className="w-3 h-3" />
              Audio ready
            </span>
          )}
          <span className="flex items-center gap-1 text-slate-600 text-[11px]">
            <Calendar className="w-3 h-3" />
            {new Date(ep.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      {/* Script preview */}
      <div className="px-5 py-4 flex-1">
        {preview ? (
          <p className="text-slate-400 text-sm leading-relaxed line-clamp-4">{preview}</p>
        ) : (
          <p className="text-slate-600 text-sm italic flex items-center gap-2">
            <FileText className="w-4 h-4" />
            No script generated yet.
          </p>
        )}
      </div>

      {/* Stats */}
      {wordCount > 0 && (
        <div className="px-5 py-2.5 border-t border-white/[0.04] flex items-center gap-4 text-[11px] text-slate-600 bg-white/[0.01]">
          <span>{wordCount.toLocaleString()} words</span>
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />~{estMin} min</span>
          <button
            onClick={handleToggleTopics}
            className="flex items-center gap-1 ml-auto text-slate-600 hover:text-slate-400 transition-colors"
          >
            <Tag className="w-3 h-3" />
            Source topics
            {showTopics ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      )}

      {/* Linked topics dropdown */}
      {showTopics && (
        <div className="px-5 pb-3 border-t border-white/[0.04] pt-3 space-y-1.5 bg-white/[0.01]">
          {linkedTopics.length === 0 ? (
            <p className="text-xs text-slate-600 italic">No topics linked to this episode.</p>
          ) : (
            linkedTopics.map(t => (
              <div key={t.id} className="flex items-center gap-2 text-xs text-slate-500">
                <div className="w-1 h-1 rounded-full bg-indigo-500/50 shrink-0" />
                <span className="truncate">{t.title}</span>
                <span className="text-slate-700 shrink-0">{t.source}</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Audio player */}
      <div className="px-5 py-4 border-t border-white/[0.05]">
        {ep.audio_url ? (
          <audio controls src={ep.audio_url} className="w-full h-9 outline-none rounded-lg" />
        ) : (
          <p className="text-center text-xs text-slate-600 py-1">
            No audio — go to Script Studio to generate it.
          </p>
        )}
      </div>
    </div>
  );
}

export default function EpisodesPage() {
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getEpisodes().then(data => { setEpisodes(data); setIsLoading(false); });
  }, []);

  return (
    <div className="space-y-7 animate-fade-up">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Episodes</h1>
          <p className="text-slate-500 text-sm mt-1">All your generated podcast episodes, ready to publish.</p>
        </div>
        <span className="text-xs text-slate-600 bg-white/[0.04] border border-white/[0.06] px-3 py-1.5 rounded-lg">
          {episodes.length} episode{episodes.length !== 1 ? "s" : ""}
        </span>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64 gap-3 text-slate-600">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading episodes...</span>
        </div>
      ) : episodes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 bg-[#13131f] border border-white/[0.06] rounded-2xl gap-4">
          <div className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/[0.07] flex items-center justify-center">
            <Headphones className="w-7 h-7 text-slate-700" />
          </div>
          <div className="text-center">
            <p className="text-slate-300 font-medium">No episodes yet</p>
            <p className="text-slate-600 text-sm mt-1">Go to Topic Discovery to create your first episode.</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {episodes.map((ep, i) => (
            <div key={ep.id} className="animate-fade-up" style={{ animationDelay: `${i * 50}ms` }}>
              <EpisodeCard ep={ep} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
