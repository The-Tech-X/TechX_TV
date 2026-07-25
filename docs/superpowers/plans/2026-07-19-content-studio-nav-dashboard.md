# Content Studio Nav, Rebrand & Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the app to The TechX Studio, rename `/social`→`/productions` and `/script-studio`→`/podcast` to match the new information architecture, and replace the old Topic-Discovery-as-homepage with a real Dashboard: a topic-card grid showing production status (Brief/Reel/Video/LinkedIn/WhatsApp/X/Podcast) across every output, per topic.

**Architecture:** Topic Discovery moves from `/` to `/discover` unchanged. `/` becomes a new Dashboard page backed by a new `app/actions/dashboard.ts` server action that joins `updates` with `social_scripts` to compute per-topic status chips. The Sidebar is rebuilt for the new route set and brand. Old routes get `next.config.ts` redirects so nothing bookmarked 404s.

**Tech Stack:** Next.js 16 App Router, React 19 client components, `@supabase/supabase-js`, Tailwind v4, `lucide-react`.

## Global Constraints

- No auto-publish/OAuth, no AI gating for LinkedIn/WhatsApp/X, no X threads, no new LLM vendor — unchanged from the backend plan; this plan touches none of that.
- No automated test suite exists in this repo; verification is manual (`npm run dev` + browser + `tsc --noEmit`), matching existing project convention.
- **Do not run `git commit` on the user's behalf at any point in this plan.** Each task ends with changes staged, not committed — the user commits everything themselves.
- Brand: **The TechX**. App name: **The TechX Studio**.
- This plan does not touch the *content* of the Productions (`/productions`, renamed from `/social`) or Podcast (`/podcast`, renamed from `/script-studio`) pages — only their route location. Trimming Productions down to a read-only ranked list and building the per-topic workspace (`/topics/[id]`) that Dashboard cards link to are separate, larger follow-up plans not yet written.
- Soft dependency: Dashboard's status chips read the `social_scripts` table, which already exists live (confirmed via code audit) regardless of whether `docs/superpowers/plans/2026-07-19-content-studio-backend.md` has been run yet. This plan works correctly either way — chips for LinkedIn/WhatsApp/X just won't light up until that backend plan's routes have been used at least once per topic.
- Interim state, by design: Dashboard cards link to `/analytics` (the existing per-topic brief page), not `/topics/[id]` — that route doesn't exist until the topic-workspace follow-up plan ships. This keeps every link in this plan pointing somewhere real; nothing 404s.

---

### Task 1: Rename `/social` → `/productions` and `/script-studio` → `/podcast`

Pure route relocation, no content changes. Done first so later tasks (Sidebar) can link to the final paths immediately instead of through a redirect hop.

**Files:**
- Rename: `app/social/` → `app/productions/` (git mv, contents untouched)
- Rename: `app/script-studio/` → `app/podcast/` (git mv, contents untouched)
- Modify: `app/analytics/page.tsx` (one line — the only internal reference to the old path)

**Interfaces:** none — pure route/path relocation, no exported signatures change.

- [ ] **Step 1: Rename the directories**

```bash
git mv app/social app/productions
git mv app/script-studio app/podcast
```

- [ ] **Step 2: Fix the one internal reference to the old path**

`app/analytics/page.tsx` navigates to Script Studio after handing topics off to it. Find:

```ts
        setTimeout(() => router.push("/script-studio"), 1200);
```

Replace with:

```ts
        setTimeout(() => router.push("/podcast"), 1200);
```

- [ ] **Step 3: Verify**

Run `npm run dev`. Visit `http://localhost:3000/productions` — the existing Social page (topic shortlist, threshold slider) should render unchanged at the new URL. Visit `http://localhost:3000/podcast` — the existing Script Studio page should render unchanged. Visiting the *old* `/social` or `/script-studio` URLs should 404 at this point — that's expected and gets fixed in Task 2.

- [ ] **Step 4: Stage for review**

`git mv` stages renames automatically. Stage the one edited file:

```bash
git add app/analytics/page.tsx
```

---

### Task 2: Rebuild the Sidebar for the new IA and brand, add redirects for old routes

**Files:**
- Modify: `app/components/Sidebar.tsx`
- Modify: `app/layout.tsx`
- Modify: `next.config.ts`

**Interfaces:** none consumed. Produces: the six-item nav (`/`, `/discover`, `/analytics`, `/productions`, `/podcast`, `/episodes`) every later task's pages are reached through.

- [ ] **Step 1: Update the icon import in `app/components/Sidebar.tsx`**

Find (line 6):

```ts
import { LayoutDashboard, FileText, Headphones, Settings, Radio, Menu, X, Brain, Clapperboard } from "lucide-react";
```

Replace with:

```ts
import { LayoutDashboard, FileText, Headphones, Radio, Menu, X, Brain, Clapperboard, Compass } from "lucide-react";
```

- [ ] **Step 2: Replace the `links` array**

Find:

```ts
const links = [
  { href: "/",              icon: LayoutDashboard, label: "Topic Discovery",  desc: "Add & curate topics" },
  { href: "/analytics",     icon: Brain,           label: "Analytics",        desc: "Per-topic briefs" },
  { href: "/script-studio", icon: FileText,        label: "Script Studio",    desc: "Edit & generate audio" },
  { href: "/episodes",      icon: Headphones,      label: "Episodes",        desc: "Browse all episodes" },
  { href: "/social",        icon: Clapperboard,    label: "Social",           desc: "Reels & Shorts scripts" },
];
```

Replace with:

```ts
const links = [
  { href: "/",             icon: LayoutDashboard, label: "Dashboard",   desc: "Production status" },
  { href: "/discover",     icon: Compass,         label: "Discover",    desc: "Add & curate topics" },
  { href: "/analytics",    icon: Brain,           label: "Analytics",   desc: "Per-topic briefs" },
  { href: "/productions",  icon: Clapperboard,    label: "Productions", desc: "Reels & Shorts scripts" },
  { href: "/podcast",      icon: FileText,        label: "Podcast",     desc: "Edit & generate audio" },
  { href: "/episodes",     icon: Headphones,      label: "Episodes",    desc: "Browse all episodes" },
];
```

- [ ] **Step 3: Remove the dead Settings link from `FooterBlock`**

Find:

```tsx
  const FooterBlock = (
    <>
      <Link
        href="/settings"
        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 group ${
          pathname === "/settings"
            ? "bg-indigo-500/10 text-white"
            : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-300"
        }`}
      >
        <div className="w-9 h-9 sm:w-8 sm:h-8 rounded-lg bg-white/[0.04] group-hover:bg-white/[0.07] flex items-center justify-center shrink-0 transition-colors">
          <Settings className="w-4 h-4" />
        </div>
        <span className="text-sm font-medium">Settings</span>
      </Link>
      <div className="px-3 py-2 flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-[11px] text-slate-600">System online</span>
      </div>
    </>
  );
```

Replace with:

```tsx
  const FooterBlock = (
    <div className="px-3 py-2 flex items-center gap-2">
      <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      <span className="text-[11px] text-slate-600">System online</span>
    </div>
  );
```

There's no `/settings` page — this link 404'd before this change (a known, previously-flagged issue). Dropping it here rather than building a real settings screen; one can be added to the nav later when there's an actual settings need.

- [ ] **Step 4: Rebrand the logo block**

Find:

```tsx
      <div>
        <span className="font-bold text-base text-white tracking-wide leading-none block">TechX TV</span>
        <span className="text-[10px] text-indigo-400/70 font-medium tracking-wider uppercase leading-none">Podcast Studio</span>
      </div>
```

Replace with:

```tsx
      <div>
        <span className="font-bold text-base text-white tracking-wide leading-none block">The TechX Studio</span>
        <span className="text-[10px] text-indigo-400/70 font-medium tracking-wider uppercase leading-none">The TechX</span>
      </div>
```

- [ ] **Step 5: Rebrand the page metadata in `app/layout.tsx`**

Find:

```tsx
export const metadata: Metadata = {
  title: "TechX TV — Podcast Studio",
  description: "AI-powered tech podcast generator. Research, script, and publish episodes with real insights.",
};
```

Replace with:

```tsx
export const metadata: Metadata = {
  title: "The TechX Studio",
  description: "The TechX's content studio — research a story once, produce a podcast episode, Reel, YouTube video, LinkedIn post, WhatsApp update, and X post from the same brief.",
};
```

- [ ] **Step 6: Add redirects for the renamed routes**

Replace the full contents of `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/script-studio", destination: "/podcast", permanent: false },
      { source: "/social", destination: "/productions", permanent: false },
    ];
  },
};

export default nextConfig;
```

`permanent: false` (307, not 308) deliberately — routes are still mid-redesign and shouldn't be permanently cached by browsers yet.

- [ ] **Step 7: Verify**

Restart `npm run dev` (redirects are read at config load). Visit `/social` — should redirect to `/productions`. Visit `/script-studio` — should redirect to `/podcast`. Check the sidebar: six items in the new order, no Settings link, logo reads "The TechX Studio" / "The TechX". Check the browser tab title reads "The TechX Studio". Click through all six nav items on both desktop width and a narrow (mobile drawer) width — confirm no broken links, no console errors (`read_console_messages` or just the browser devtools console).

- [ ] **Step 8: Stage for review**

```bash
git add app/components/Sidebar.tsx app/layout.tsx next.config.ts
```

---

### Task 3: Dashboard data layer

**Files:**
- Modify: `app/actions/updates.ts` (export the existing private `currentWeekId` helper)
- Create: `app/actions/dashboard.ts`

**Interfaces:**
- Consumes: `currentWeekId()` from `./updates` (exported by this task).
- Produces: `DashboardTopic` type and `getDashboardTopics(scope: 'week' | 'all'): Promise<DashboardTopic[]>`. Task 4's Dashboard page imports both from `../actions/dashboard` (relative to `app/page.tsx`, i.e. `./actions/dashboard`).

- [ ] **Step 1: Export `currentWeekId` from `app/actions/updates.ts`**

Find (around line 24):

```ts
function currentWeekId(): string {
```

Replace with:

```ts
export function currentWeekId(): string {
```

No other change to that function's body.

- [ ] **Step 2: Create `app/actions/dashboard.ts`**

```ts
"use server";

import { createClient } from '@supabase/supabase-js';
import { currentWeekId } from './updates';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export type DashboardTopic = {
  id: string;
  title: string;
  source: string | null;
  status: string;
  social_score: number | null;
  recommended_platform: string | null;
  episode_id: string | null;
  analysis_json: unknown;
  week_id: string | null;
  created_at: string;
  /** platform keys with a 'done' social_scripts row: any of 'instagram'|'youtube'|'linkedin'|'whatsapp'|'x' */
  platforms: string[];
};

export async function getDashboardTopics(scope: 'week' | 'all' = 'week'): Promise<DashboardTopic[]> {
  let query = supabase
    .from('updates')
    .select('id,title,source,status,social_score,recommended_platform,episode_id,analysis_json,week_id,created_at')
    .order('social_score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (scope === 'week') {
    query = query.eq('week_id', currentWeekId());
  }

  const { data: updates, error } = await query;
  if (error) {
    console.error('[Dashboard] getDashboardTopics error:', error);
    return [];
  }
  if (!updates || updates.length === 0) return [];

  const ids = updates.map((u) => u.id);
  const { data: scripts, error: scriptsErr } = await supabase
    .from('social_scripts')
    .select('update_id, platform')
    .in('update_id', ids)
    .eq('status', 'done');
  if (scriptsErr) console.error('[Dashboard] social_scripts fetch error:', scriptsErr);

  const platformsByUpdate = new Map<string, string[]>();
  for (const row of scripts || []) {
    if (!row.update_id) continue;
    const list = platformsByUpdate.get(row.update_id) ?? [];
    list.push(row.platform);
    platformsByUpdate.set(row.update_id, list);
  }

  return updates.map((u) => ({
    ...u,
    platforms: platformsByUpdate.get(u.id) ?? [],
  })) as DashboardTopic[];
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `app/actions/dashboard.ts` or `app/actions/updates.ts`.

- [ ] **Step 4: Stage for review**

```bash
git add app/actions/updates.ts app/actions/dashboard.ts
```

---

### Task 4: Move Topic Discovery to `/discover`, build the Dashboard at `/`

**Files:**
- Create: `app/discover/page.tsx` (exact current contents of `app/page.tsx`, unmodified — it doesn't reference its own path anywhere, so this is a pure relocation)
- Modify: `app/page.tsx` (replaced entirely with the new Dashboard)

**Interfaces:**
- Consumes: `getDashboardTopics`, `DashboardTopic` from `../actions/dashboard` → `./actions/dashboard` (Task 3).

- [ ] **Step 1: Create `app/discover/page.tsx` with today's `app/page.tsx` contents, unchanged**

Copy the current full contents of `app/page.tsx` (the Topic Discovery page — URL/topic input, active/done tabs, topic list, detail drawer, "Run Analytics" confirmation modal) verbatim into the new file `app/discover/page.tsx`. No line inside it changes — it doesn't hardcode `/` or reference its own route anywhere.

```bash
git mv app/page.tsx app/discover/page.tsx
```

(Using `git mv` here rather than copy+delete since content is unchanged — Step 2 recreates `app/page.tsx` fresh as the new Dashboard.)

- [ ] **Step 2: Create the new `app/page.tsx` (Dashboard)**

```tsx
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
          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/25"
          : "bg-white/[0.02] text-slate-700 border-white/[0.05]"
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
      onClick={() => router.push("/analytics")}
      className="bg-[#13131f] border border-white/[0.06] rounded-2xl p-4 cursor-pointer hover:border-indigo-500/30 hover:bg-white/[0.02] transition-all group"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-sm font-medium text-slate-200 leading-snug line-clamp-2 group-hover:text-indigo-300 transition-colors">
          {topic.title}
        </h3>
        <ChevronRight className="w-4 h-4 text-slate-700 group-hover:text-slate-500 shrink-0 mt-0.5" />
      </div>
      <p className="text-[11px] text-slate-600 mb-3 truncate">{topic.source ?? "Unknown source"}</p>

      {topic.social_score != null && (
        <div className="mb-3">
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
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
  const [scope, setScope] = useState<"week" | "all">("week");
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
          <h1 className="text-xl sm:text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-slate-500 text-xs sm:text-sm mt-1">Every topic, every output, one view.</p>
        </div>
        <button
          onClick={() => router.push("/discover")}
          className="flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-500/20 whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Topics
        </button>
      </div>

      <div className="flex items-center gap-1 bg-[#0c0c18] p-1 rounded-xl border border-white/[0.06] w-fit">
        {(["week", "all"] as const).map(s => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              scope === s ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20" : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {s === "week" ? "This week" : "All weeks"}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="py-16 flex justify-center">
          <Loader2 className="w-5 h-5 text-slate-600 animate-spin" />
        </div>
      )}

      {!isLoading && topics.length === 0 && (
        <div className="bg-[#13131f] border border-white/[0.06] rounded-2xl py-16 text-center">
          <div className="w-12 h-12 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mx-auto mb-3">
            <LayoutGrid className="w-5 h-5 text-slate-700" />
          </div>
          <p className="text-slate-500 text-sm">
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
```

Card clicks go to `/analytics` for now (see Global Constraints) — the topic-workspace follow-up plan changes this one line (`router.push("/analytics")` → `router.push(\`/topics/${topic.id}\`)`) once that route exists.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `app/page.tsx` or `app/discover/page.tsx`.

- [ ] **Step 4: Verify in the browser**

Run `npm run dev`. Visit `/discover` — confirm it's identical to how `/` used to look (URL input, active/done tabs, list). Visit `/` — confirm the new Dashboard renders: header, "This week"/"All weeks" toggle, and a card grid. If there's at least one topic with `analysis_json` set from earlier use of the app, confirm its card shows a filled "BR" chip; if that topic also has generated scripts (e.g. from the backend plan's Task 4 verification), confirm the corresponding chips (RL/VD/LI/WA/X) are filled too, and unfilled for platforms not yet generated. Toggle "All weeks" and confirm topics from other weeks appear (or confirm "This week" correctly narrows to fewer topics, if you have multi-week data). Click a card — confirm it navigates to `/analytics`.

- [ ] **Step 5: Stage for review**

```bash
git add app/discover/page.tsx app/page.tsx
```
