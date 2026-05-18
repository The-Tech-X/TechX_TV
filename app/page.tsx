"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getUpdates, saveUpdate, toggleUpdateStatus } from "./actions/updates";
import { Link2, Plus, Zap, Loader2, X, CheckCircle2, Circle, ExternalLink, ChevronRight, Brain, Trash2, RefreshCw, Languages, ArrowRight } from "lucide-react";
import { deleteUpdate } from "./actions/updates";

export default function TopicDiscoveryPage() {
  const router = useRouter();
  const [updates, setUpdates] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newUrl, setNewUrl] = useState("");
  const [episodeName, setEpisodeName] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [isScraping, setIsScraping] = useState(false);
  const [selectedTopicDetails, setSelectedTopicDetails] = useState<any | null>(null);
  const [activeTab, setActiveTab] = useState<"active" | "done">("active");
  const [language, setLanguage] = useState<"english" | "tenglish">("english");

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setIsLoading(true);
    setUpdates(await getUpdates());
    setIsLoading(false);
  }

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

  const handleGoToAnalytics = () => {
    if (!episodeName.trim() || selectedCount === 0) return;
    const qs = new URLSearchParams({ episode: episodeName.trim(), lang: language });
    router.push(`/analytics?${qs.toString()}`);
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
      setNewUrl(""); setManualDescription("");
    } catch {
      const saved = await saveUpdate({ title: newUrl, source: "Manual (fallback)", status: "selected", content: manualDescription || "" });
      setUpdates(prev => [saved, ...prev]);
      setNewUrl(""); setManualDescription("");
    } finally {
      setIsScraping(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Topic Discovery</h1>
          <p className="text-slate-500 text-sm mt-1">Add news articles, select what makes the cut, then run analytics to brief the script writer.</p>
        </div>

        {/* Episode launch bar */}
        <div className="flex items-center gap-2 bg-[#13131f] border border-white/[0.07] rounded-2xl p-2 shadow-xl shrink-0">
          <input
            type="text"
            value={episodeName}
            onChange={e => setEpisodeName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleGoToAnalytics()}
            placeholder="Episode name (e.g. Ep-01)"
            className="bg-transparent outline-none text-sm text-slate-200 placeholder-slate-600 px-3 w-44"
          />
          <div className="w-px h-5 bg-white/10 shrink-0" />

          {/* Language toggle — picks the script-writer's voice on the next step */}
          <div
            className="flex items-center gap-0.5 bg-[#0c0c18] p-0.5 rounded-lg border border-white/[0.06] shrink-0"
            title="Script language — English uses Llama-3-70B, Tenglish uses Sarvam-M"
          >
            <Languages className="w-3.5 h-3.5 text-slate-600 ml-1.5" />
            {(["english", "tenglish"] as const).map(lang => (
              <button
                key={lang}
                type="button"
                onClick={() => setLanguage(lang)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all capitalize ${
                  language === lang
                    ? "bg-indigo-500 text-white shadow"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {lang}
              </button>
            ))}
          </div>

          <div className="w-px h-5 bg-white/10 shrink-0" />
          {selectedCount > 0 && (
            <span className="text-xs font-semibold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-lg whitespace-nowrap border border-indigo-500/15">
              {selectedCount} selected
            </span>
          )}
          <button
            onClick={handleGoToAnalytics}
            disabled={!episodeName.trim() || selectedCount === 0}
            title="Run Tavily web search + Mistral Large analysis on selected topics"
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 disabled:shadow-none text-white text-sm px-4 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-500/20 whitespace-nowrap"
          >
            <Brain className="w-3.5 h-3.5" />
            Analyze Topics
            <ArrowRight className="w-3.5 h-3.5 opacity-80" />
          </button>
        </div>
      </div>

      {/* Add topic */}
      <div className="bg-[#13131f] border border-white/[0.06] rounded-2xl p-5 card-glow">
        <h2 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
          <Plus className="w-4 h-4 text-indigo-400" />
          Add Topic or URL
        </h2>
        <div className="space-y-3">
          <div className="flex items-center gap-3 bg-[#0c0c18] border border-white/[0.06] rounded-xl px-4 focus-within:border-indigo-500/40 transition-colors">
            <Link2 className="w-4 h-4 text-slate-600 shrink-0" />
            <input
              type="text"
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAddTopic()}
              placeholder="Paste a URL to auto-scrape, or type a topic title manually..."
              className="flex-1 bg-transparent py-3 text-sm text-slate-200 placeholder-slate-600 outline-none"
            />
            {newUrl && (
              <button onClick={() => setNewUrl("")} className="text-slate-600 hover:text-slate-400">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <textarea
              value={manualDescription}
              onChange={e => setManualDescription(e.target.value)}
              placeholder="Optional: paste article content or description for better AI analysis..."
              rows={2}
              className="flex-1 bg-[#0c0c18] border border-white/[0.06] rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-600 outline-none resize-none focus:border-indigo-500/40 transition-colors"
            />
            <button
              onClick={handleAddTopic}
              disabled={isScraping || !newUrl.trim()}
              className="flex flex-col items-center justify-center gap-1 bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-40 text-slate-300 hover:text-white px-5 rounded-xl border border-white/[0.06] min-w-[80px] transition-all"
            >
              {isScraping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              <span className="text-xs">{isScraping ? "Fetching..." : "Add"}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Topics list */}
      <div className="bg-[#13131f] border border-white/[0.06] rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06] bg-white/[0.01]">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-[#0c0c18] p-1 rounded-xl border border-white/[0.06]">
              {(["active", "done"] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all capitalize ${
                    activeTab === tab ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20" : "text-slate-500 hover:text-slate-300"
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
              <span className="text-xs text-slate-500">
                {selectedCount} of {updates.filter(u => u.status !== "done").length} selected
              </span>
            )}
          </div>
          <button
            onClick={loadData}
            className="p-1.5 rounded-lg hover:bg-white/[0.05] text-slate-600 hover:text-slate-400 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="divide-y divide-white/[0.04]">
          {filteredUpdates.length === 0 && !isLoading && (
            <div className="py-16 text-center">
              <div className="w-12 h-12 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mx-auto mb-3">
                <Zap className="w-5 h-5 text-slate-700" />
              </div>
              <p className="text-slate-500 text-sm">
                {activeTab === "active" ? "No topics yet. Add one above to get started!" : "No processed topics yet."}
              </p>
            </div>
          )}
          {isLoading && (
            <div className="py-10 flex justify-center">
              <Loader2 className="w-5 h-5 text-slate-600 animate-spin" />
            </div>
          )}
          {filteredUpdates.map((update, i) => (
            <div
              key={update.id}
              className="flex items-center gap-4 px-5 py-3.5 hover:bg-white/[0.02] transition-colors group animate-fade-up"
              style={{ animationDelay: `${i * 25}ms` }}
            >
              {/* Select toggle — only on active */}
              {activeTab === "active" ? (
                <button
                  onClick={() => handleSelect(update.id, update.status)}
                  className="shrink-0 hover:scale-110 transition-transform"
                >
                  {update.status === "selected"
                    ? <CheckCircle2 className="w-5 h-5 text-indigo-400" />
                    : <Circle className="w-5 h-5 text-slate-700 hover:text-slate-500" />
                  }
                </button>
              ) : (
                <CheckCircle2 className="w-5 h-5 text-emerald-500/60 shrink-0" />
              )}

              {/* Title + source */}
              <div
                className="flex-1 min-w-0 cursor-pointer"
                onClick={() => setSelectedTopicDetails(update)}
              >
                <p className={`text-sm font-medium leading-snug truncate transition-colors group-hover:text-indigo-300 ${
                  update.status === "selected" ? "text-white" : "text-slate-300"
                }`}>
                  {update.title}
                </p>
                <p className="text-xs text-slate-600 mt-0.5 truncate">{update.source}</p>
              </div>

              {/* Right side badges + actions */}
              <div className="flex items-center gap-2 shrink-0">
                {update.episode_id && (
                  <span className="text-[10px] text-slate-600 bg-white/[0.04] px-2 py-0.5 rounded border border-white/[0.05]">
                    linked
                  </span>
                )}
                {update.status === "selected" && (
                  <span className="px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-400 text-[11px] font-semibold border border-indigo-500/15">
                    Selected
                  </span>
                )}
                <ChevronRight className="w-4 h-4 text-slate-700 group-hover:text-slate-500 transition-colors" />
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(update.id); }}
                  className="p-1 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-slate-600 hover:text-red-400 transition-all"
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
          className="fixed inset-0 z-50 flex justify-end animate-fade-in"
          style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
          onClick={() => setSelectedTopicDetails(null)}
        >
          <div
            className="w-full max-w-lg bg-[#0f0f1a] border-l border-white/[0.08] h-full overflow-y-auto flex flex-col animate-slide-right"
            onClick={e => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-[#0f0f1a]/95 backdrop-blur-md border-b border-white/[0.07] px-6 py-5 z-10">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <h2 className="text-base font-semibold text-white leading-snug">{selectedTopicDetails.title}</h2>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className="text-xs px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 font-medium">
                      {selectedTopicDetails.source}
                    </span>
                    {selectedTopicDetails.url && (
                      <a
                        href={selectedTopicDetails.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        View original
                      </a>
                    )}
                    {selectedTopicDetails.episode_id && (
                      <span className="text-xs text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded border border-white/[0.06]">
                        Episode linked
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedTopicDetails(null)}
                  className="p-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-slate-400 hover:text-white transition-colors shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 px-6 py-6 text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">
              {selectedTopicDetails.content || "No content available."}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
