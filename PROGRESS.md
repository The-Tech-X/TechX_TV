# TechX TV — Build Progress

## What Was Built (June 2026)

Starting from a working 4-page podcast studio, the system was expanded into a full multi-channel media production platform. This file documents every architectural decision and what was changed and why.

---

## Original System (Before This Sprint)

- 4 pages: Topic Discovery, Analytics, Script Studio, Episodes
- One content output: weekly podcast (English + Tenglish)
- Analytics: auto-triggered on page mount, per-topic Tavily + Mistral
- No social media features
- `language` parameter throughout the pipeline (English or Tenglish)

---

## What Changed and Why

### 1. Tenglish Removed (English Only)

**Files changed:** `app/api/analyze/route.ts`, `app/analytics/page.tsx`, `app/script-studio/page.tsx`, `app/episodes/page.tsx`, `app/actions/episodes.ts`, `app/page.tsx`

Removed the `tenglishSystemPrompt` (~80 lines), language toggle UI, `language` state and URL param, `lang=` query string, and all `language` references from episode metadata. Both paths now use the English system prompt only. The Sarvam-M model experiment (tried and dropped before this sprint) is fully cleaned up.

---

### 2. Database Schema Extended

**New columns on `updates`:** `social_score float`, `recommended_platform text`, `social_reasoning text`, `platform_override text`, `week_id text`

**New tables:** `social_scripts`, `youtube_concepts`

**Migration approach:** Non-breaking. Added columns to existing table, created new tables with proper FK relationships and check constraints. `week_id` backfilled on existing rows via `to_char(created_at, 'IYYY-"W"IW')`.

**`week_id` auto-stamping:** `saveUpdate()` in `app/actions/updates.ts` now stamps every new topic with the current ISO week on save.

---

### 3. Analytics Redesigned — Two Phases, Manual Trigger

**File:** `app/api/analytics/route.ts` (full rewrite)

**Why two phases:**
- Phase 1 (unchanged in structure): per-topic Tavily + Mistral, runs in `Promise.all` for speed
- Phase 2 (new): one batch Mistral call that sees ALL topic summaries together — enables relative ranking ("topic 3 is the best Instagram candidate *compared to everything else this week*"). Per-topic scoring in isolation has no baseline.

**Phase 2 output per topic:** `social_score` (0-10), `recommended_platform` ('instagram'/'youtube'/'none'), `social_reasoning` (one-line explanation). Strict prompt — only 2-3 topics per batch should score above 7.0.

**Phase 2 failure is non-fatal** — Phase 1 results are already committed to DB before Phase 2 runs.

**Why manual trigger (no auto-start):** Auto-triggering on page mount was removed from `app/analytics/page.tsx`. Reasons: (1) batch analysis on Tuesday gives Phase 2 the full week's context, (2) incremental analysis throughout the week means each Phase 2 only sees a partial picture. The "Analyze Topics (N)" button in the sticky bar triggers analysis only when clicked.

**Unanalyzed topics** now show a clean "Not yet analyzed — click Analyze Topics" state instead of an immediate spinner.

---

### 4. Episode Name Moved to Analytics Only

**Files:** `app/page.tsx` (removed), `app/analytics/page.tsx` (kept)

The episode name input was in both Topic Discovery and Analytics. Removed from Topic Discovery — it belongs in Analytics where it's actually used (as the `week_id` for the episode). The "Go to Analytics" button was renamed "Run Analytics" and now shows a confirmation modal asking "Weekly news ready?" before navigating — reminds the user that batch analysis works best when all week's topics are collected.

---

### 5. Social Page Built (`/social`)

**New files:** `app/social/page.tsx`, `app/actions/social.ts`, `app/api/social-script/route.ts`, `app/api/youtube-concept/route.ts`

**What it does:**
- Loads all topics with social scores
- **Threshold slider** (default 7.0): topics above threshold appear in the shortlist, below go to the ignored drawer
- **AI Shortlist**: platform badge ([Reel] or [Video]), reasoning, two script buttons per topic
- **Ignored Drawer**: collapsible, with "Override — include anyway" button
- **Override persistence**: writes `platform_override` to DB via `saveOverride()` server action — not session-only
- **Re-score All button**: sends all analyzed IDs to `/api/analytics` with `force: false` — Phase 1 skips already-analyzed topics, Phase 2 re-runs on all for fresh relative ranking
- **YouTube Concept Panel**: date range picker, generates AI concept analysis, presents two options (synthesized multi-week concept vs best single topic), generates full video script from chosen option

**Sidebar updated** with Social link (Clapperboard icon).

---

### 6. Instagram Reel Script Generation

**File:** `app/api/social-script/route.ts` — `INSTAGRAM_SYSTEM_PROMPT`

**Architecture of the prompt:**
- Audience explicitly defined: CS students, developers, founders, PMs, tech professionals, anyone curious about tech — not developer-only
- Hook: one of three share trigger angles (information asymmetry / validation / consequence) — model picks ONE, does not blend
- Body: builds information asymmetry across bullets; last bullet is the loop anchor (echoes hook for clean replay — Instagram counts rewatches)
- CTA: share-first, targets the specific audience type for this story
- Hard rule: exact numbers from keyFacts, never paraphrased into vagueness

**Output shape:** `{ hook: string, bullets: string[], cta: string }`

---

### 7. YouTube Video Script Generation (Full Length)

**File:** `app/api/social-script/route.ts` — `YOUTUBE_VIDEO_SYSTEM_PROMPT`

Replaced what was previously a YouTube Shorts prompt. Full 8-15 minute analytical video, not a news recap. Prompt engineers:
- Hook (scripted): establishes tension the video resolves, specific facts from analysis
- 4-5 sections: The What / The Why / The Mechanism / The So What / Honest Take (adapt per story)
- Conclusion (scripted): calls back to hook, lands Teja's final take
- Hook and conclusion are word-for-word; sections are talking points for natural delivery

**Output shape:** `{ hook: string, sections: [{title: string, points: string[]}], conclusion: string }`

---

### 8. YouTube Concept Generation

**File:** `app/api/youtube-concept/route.ts`

User selects a date range (typically 2-3 weeks). Route fetches all analyzed updates in that range and sends all summaries to Mistral in one call. Returns two options:
- **Option A (Synthesized)**: a concept that emerges from patterns across all weeks — a thesis, not a collection of stories
- **Option B (Best Single)**: the strongest standalone topic for a deep-dive video, or null if none qualifies

Model outputs its recommendation and reasoning. User picks. Then generates the full video script from the chosen option via `/api/social-script`.

---

### 9. QStash Keys Activated

QStash keys were in `.env` but commented out. Uncommented. Need to be added to Render environment variables before production deployment. QStash is currently only wired to `/api/analyze` (podcast script generation) — analytics and social script routes run synchronously.

---

## Pending Before Production

| Item | Status |
|---|---|
| Add QStash keys to Render environment | Pending |
| Run SQL: `ALTER TABLE social_scripts DROP CONSTRAINT social_scripts_platform_check; ALTER TABLE social_scripts ADD CONSTRAINT social_scripts_platform_check CHECK (platform IN ('instagram', 'youtube'));` | Confirm done |

---

## Architecture Decisions Made and Why

**Why Mistral Large for analysis/scoring, Llama-70B for podcast scripts?**
Mistral Large produces tight, structured JSON reliably (good for analysis briefs and social scoring). Llama-70B is better at flowing long-form narrative (good for 8000-token podcast scripts). Each model does what it's best at.

**Why fire-and-forget + self-callback for podcast scripts?**
Llama-70B with 8K output tokens takes 6-10 minutes to respond. No serverless platform tolerates that as a synchronous request. The inline fire-and-forget pattern on Render (persistent Node server) handles this cleanly. QStash is the alternative path for serverless deployments.

**Why Phase 2 is a separate batch call and not embedded in Phase 1?**
Per-topic scoring in isolation has no comparative baseline — the AI can't know if a topic is "the best of the week" without seeing the others. One call with all topics enables genuine relative ranking. This is the core reason social scoring is accurate.

**Why is override saved to DB and not just client state?**
Session-only overrides are useless for a creator workflow. If you override a topic on Tuesday and come back on Wednesday to generate scripts, the override needs to still be there. `platform_override` column persists this correctly.

**Why is there no Settings table?**
The social threshold (the only user preference) is stored in `localStorage` via the range slider on the `/social` page. Single-creator tool — no need for DB-persisted preferences.
