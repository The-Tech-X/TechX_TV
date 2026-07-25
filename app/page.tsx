"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getDashboardTopics, type DashboardTopic } from "./actions/dashboard";
import { Loader2, Plus, ChevronRight, LayoutGrid } from "lucide-react";

function StatusChip({ label, done, title }: { label: string; done: boolean; title: string }) {
  return (
    <span
      title={title}
      className={`min-w-[22px] h-5 px-1 flex items-center justify-center rounded text-[9px] font-bold border ${
        done
          ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/25"
          : "bg-black/[0.02] text-neutral-400 border-black/[0.07]"
      }`}
    >
      {label}
    </span>
  );
}

function DashboardTopicCard({ topic }: { topic: DashboardTopic }) {
  const router = useRouter();
  const hasBrief = !!topic.analysis_json;
  const has = (p: string) => topic.platforms.includes(p);
  const scoreLabel =
    topic.recommended_platform === "instagram" ? "Reel" :
    topic.recommended_platform === "youtube"   ? "Video" : "No pick";

  return (
    <div
      onClick={() => router.push(`/topics/${topic.id}`)}
      className="bg-white border border-black/[0.08] rounded-2xl p-4 cursor-pointer hover:bg-black/[0.02] transition-all group card-glow"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-sm font-medium text-neutral-900 leading-snug line-clamp-2 group-hover:text-red-600 transition-colors">
          {topic.title}
        </h3>
        <ChevronRight className="w-4 h-4 text-neutral-300 group-hover:text-neutral-500 shrink-0 mt-0.5" />
      </div>
      <p className="text-[11px] text-neutral-400 mb-3 truncate">{topic.source ?? "Unknown source"}</p>

      {topic.social_score != null && (
        <div className="mb-3">
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-red-500/10 text-red-600 border border-red-500/20">
            {scoreLabel} · {Number(topic.social_score).toFixed(1)}
          </span>
        </div>
      )}

      <div className="flex items-center gap-1 flex-wrap">
        <StatusChip label="BR" done={hasBrief} title="Research brief" />
        <StatusChip label="RL" done={has("instagram")} title="Instagram Reel" />
        <StatusChip label="VD" done={has("youtube")} title="YouTube Video" />
        <StatusChip label="LI" done={has("linkedin")} title="LinkedIn post" />
        <StatusChip label="WA" done={has("whatsapp")} title="WhatsApp update" />
        <StatusChip label="X"  done={has("x")} title="X post" />
        <StatusChip label="PC" done={!!topic.episode_id} title="Included in a podcast episode" />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [topics, setTopics] = useState<DashboardTopic[]>([]);
  const [scope, setScope] = useState<"week" | "all">("all");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => { load(scope); }, [scope]);

  async function load(nextScope: "week" | "all") {
    setIsLoading(true);
    setTopics(await getDashboardTopics(nextScope));
    setIsLoading(false);
  }

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-up">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-black">Dashboard</h1>
          <p className="text-neutral-500 text-xs sm:text-sm mt-1">Every topic, every output, one view.</p>
        </div>
        <button
          onClick={() => router.push("/discover")}
          className="flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-500 text-white text-sm px-4 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-red-500/20 whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Topics
        </button>
      </div>

      <div className="flex items-center gap-1 bg-[#f5f5f5] p-1 rounded-xl border border-black/[0.08] w-fit">
        {(["week", "all"] as const).map(s => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              scope === s ? "bg-red-600 text-white shadow-lg shadow-red-500/20" : "text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {s === "week" ? "This week" : "All weeks"}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="py-16 flex justify-center">
          <Loader2 className="w-5 h-5 text-neutral-400 animate-spin" />
        </div>
      )}

      {!isLoading && topics.length === 0 && (
        <div className="bg-white border border-black/[0.08] rounded-2xl py-16 text-center">
          <div className="w-12 h-12 rounded-2xl bg-black/[0.03] border border-black/[0.08] flex items-center justify-center mx-auto mb-3">
            <LayoutGrid className="w-5 h-5 text-neutral-300" />
          </div>
          <p className="text-neutral-500 text-sm">
            {scope === "week" ? "No topics for this week yet." : "No topics yet."} Add one to get started.
          </p>
        </div>
      )}

      {!isLoading && topics.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {topics.map(topic => <DashboardTopicCard key={topic.id} topic={topic} />)}
        </div>
      )}
    </div>
  );
}
