# TechX TV — Agent Guide

## What this app is

A **multi-channel media production studio** for a weekly tech content creator. Built on Next.js 16 (App Router, Turbopack, React 19). Produces three content types from the same weekly news intake:

1. **Weekly podcast episode** — full-length flowing monologue script + synthesized audio
2. **Instagram Reels** — 30–45 second curiosity-driven, share-engineered scripts
3. **YouTube Videos** — 8–15 minute analytical deep-dive scripts (full length, not Shorts)

State lives in Supabase Postgres. Audio lives in a Supabase Storage bucket. Deploys to Render (persistent Node server, no per-request timeout). Optional Upstash QStash for serverless environments.

**Tenglish is fully removed.** English only. Any reference to Tenglish, Sarvam-M, or a `language` parameter in the analyze pipeline is stale — ignore it.

---

## End-to-end flow

```
WEEKLY WORKFLOW
───────────────
Monday–Monday: Paste URLs → /api/scrape → saved to updates table with week_id
               Select topics (status: 'selected')

Tuesday evening:
  /  (Topic Discovery)
      → click "Run Analytics" → confirmation modal → navigate to /analytics

  /analytics
      → topics load in "pending" state (NO auto-trigger)
      → click "Analyze Topics (N)" in sticky bar
          → /api/analytics:
              Phase 1: Tavily web search + Mistral Large brief per topic (parallel)
                       saves: analysis_json {summary, whyNow, keyFacts[], biggerPicture, honestTake, sources}
              Phase 2: one batch Mistral call sees ALL topics together
                       saves: social_score, recommended_platform, social_reasoning per topic
      → user reviews + edits briefs
      → name episode, click "Generate Script (N)"
          → /api/analyze → Llama-3.1-70B → episodes.script_text

  /script-studio
      → edit script → click "Generate Audio"
          → /api/tts → Edge TTS → MP3 → Supabase Storage

  /social (next day or whenever)
      → shortlist shows scored topics above threshold
      → click "Gen Reel Script" → /api/social-script (Instagram prompt)
      → click "Gen YT Script" → /api/social-script (YouTube Video prompt)
      → YouTube Concept panel: pick date range → /api/youtube-concept
          → AI synthesizes concept from multiple weeks OR picks best single topic
          → click "Generate full script" → /api/social-script (YouTube Video prompt)

ARCHIVE
───────
  /episodes  — browse all episodes, play audio inline
```

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack), React 19, TypeScript 5 |
| Styling | Tailwind v4, Lucide icons, dark theme |
| DB + Storage | Supabase (Postgres + `audio` storage bucket) |
| Web search | Tavily (`search_depth: advanced`, 6 results, includes answer) |
| Analyst LLM | `mistralai/mistral-large-3-675b-instruct-2512` via NVIDIA NIM |
| Script writer | `meta/llama-3.1-70b-instruct` via NVIDIA NIM |
| Social scripts | `mistralai/mistral-large-3-675b-instruct-2512` via NVIDIA NIM |
| TTS | `@seepine/edge-tts` → `en-US-AndrewNeural` |
| Article scrape | `jsdom` + `@mozilla/readability` |
| Background queue | Upstash QStash — only for serverless; auto-detected at runtime |

---

## Project layout

```
app/
  page.tsx                  Topic Discovery — URL input, scrape, select, Run Analytics button
  analytics/page.tsx        Per-topic editable briefs, manual analyze trigger, generate podcast script
  script-studio/page.tsx    Episode list, script editor, audio generation, retry
  episodes/page.tsx         Read-only archive, inline audio player
  social/page.tsx           Social shortlist, threshold slider, ignored drawer, YouTube concept panel
  layout.tsx                Dark shell, ambient blobs, Sidebar mount
  components/Sidebar.tsx    Desktop static / mobile slide-in nav (5 links including /social)
  lib/episodeStatus.ts      Derives 'ready'|'generating'|'failed'|'pending' from row fields
  actions/
    updates.ts              Topic CRUD + analysis save + getAnalyzableUpdates + week_id stamping
    episodes.ts             Episode read/save + getTopicsForEpisodeRetry
    social.ts               getScoredUpdates + saveOverride + getAllAnalyzedUpdateIds
  api/
    scrape/route.ts         URL → Readability → {title, source, url, content}
    analytics/route.ts      Phase1: topicIds[] → Tavily+Mistral → analysis_json (parallel)
                            Phase2: all topics → Mistral → social_score, recommended_platform, social_reasoning
    analyze/route.ts        topics+briefs → Llama-70B → episodes.script_text (fire-and-forget + self-callback)
    tts/route.ts            text → Edge TTS → upload mp3 → episodes.audio_url
    social-script/route.ts  updateId+platform → Mistral → {hook,bullets,cta} or {hook,sections[],conclusion}
    youtube-concept/route.ts dateFrom+dateTo → fetch updates → Mistral → concept JSON
```

---

## Data model

### `updates` — one row per scraped news topic

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `title` | text | |
| `url` | text | |
| `source` | text | domain extracted from URL |
| `content` | text | Readability-extracted article text |
| `status` | text | `'pending' \| 'selected' \| 'done'` |
| `analysis_json` | jsonb | `{summary, whyNow, keyFacts[], biggerPicture, honestTake, sources:[]}` |
| `social_score` | float | 0–10, set by Phase 2 batch scoring |
| `recommended_platform` | text | `'instagram' \| 'youtube' \| 'none'` |
| `social_reasoning` | text | one-line AI explanation of the score |
| `platform_override` | text | user override: `'instagram' \| 'youtube' \| 'none'` — persists across sessions |
| `week_id` | text | e.g. `"2026-W23"` — auto-stamped on save, backfilled via migration |
| `episode_id` | uuid → episodes | set when topic is linked to a finished script |
| `created_at`, `updated_at` | timestamptz | `updated_at` auto-bumped by trigger |

### `episodes` — one row per generated podcast episode

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `week_id` | text unique | user-supplied name like `"Ep-01"` |
| `script_text` | text | finished script — presence means ready |
| `analysis_json` | jsonb | run status: `{status:'generating'\|'failed', error?, model, topic_ids[], started_at\|failed_at}` |
| `audio_url` | text | public URL in the `audio` Supabase Storage bucket |
| `created_at`, `updated_at` | timestamptz | |

Episode status is **derived**, not stored — see `app/lib/episodeStatus.ts`. There is no `status` column on `episodes`.

### `social_scripts` — generated Instagram/YouTube scripts

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `update_id` | uuid → updates | nullable (null for synthesized YouTube concepts) |
| `youtube_concept_id` | uuid → youtube_concepts | nullable (set for concept-derived scripts) |
| `platform` | text | `'instagram' \| 'youtube'` |
| `script_json` | jsonb | Instagram: `{hook, bullets[], cta}` — YouTube: `{hook, sections:[{title,points[]}], conclusion}` |
| `status` | text | `'pending' \| 'done' \| 'failed'` |
| `created_at`, `updated_at` | timestamptz | |

Unique constraint: `(update_id, platform)`.

### `youtube_concepts` — multi-week video concept analysis

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `date_from`, `date_to` | date | the user-selected range |
| `update_ids` | uuid[] | all updates included in this analysis |
| `concept_json` | jsonb | `{synthesized:{title,thesis,why,outline[]}, best_single:{update_id,title,why}, recommendation, recommendation_reason}` |
| `chosen_option` | text | `'synthesized' \| 'best_single'` — set when user picks |
| `status` | text | `'pending' \| 'concept_ready' \| 'scripted' \| 'done' \| 'failed'` |
| `created_at`, `updated_at` | timestamptz | |

---

## API route conventions

- All routes: `runtime = 'nodejs'`. Long ones set `maxDuration` explicitly.
- `/api/analytics` (300s): two-phase. Phase 1 runs per-topic in `Promise.all` (~2-4 min for 10 topics). Phase 2 is one batch Mistral call on all results together — enables relative ranking. Phase 2 failure is non-fatal; Phase 1 results are already saved.
- `/api/analyze` (60s declared, 15min effective via undici): split into trigger + self-callback pattern.
  - First POST (no `?isCallback`): kicks off NIM fire-and-forget, returns `{success, status}` immediately. Writes `analysis_json.status='generating'`.
  - Self-callback (`?isCallback=true`): receives NIM response, strips `<think>` tags, parses JSON defensively (regex fallback for truncated output), writes `script_text`, links `updates.episode_id`.
- `/api/social-script` (120s): single Mistral call per request. Returns different JSON shapes for Instagram vs YouTube — detect by presence of `script.sections`.
- `/api/youtube-concept` (180s): fetches all analyzed updates in date range, single Mistral call, returns two options (synthesized + best single).

---

## Social scoring — Phase 2 details

Phase 2 runs immediately after Phase 1 completes within the same `/api/analytics` request. It sends all topic summaries to Mistral in one call for **relative ranking** (not per-topic isolation). Results:

- `social_score` 0–10: only 2-3 topics per typical batch should score above 7.0
- `recommended_platform`: `'instagram'` (shareable/relatable, high share impulse), `'youtube'` (deep enough to sustain 8-15 min analysis), or `'none'`
- `social_reasoning`: one-line explanation

**Re-score All button** on `/social`: sends all analyzed update IDs to `/api/analytics` with `force: false`. Phase 1 skips all (already have `analysis_json`), Phase 2 re-runs on everything — correct approach for re-ranking after adding new topics.

---

## Script output formats

### Instagram Reel (`platform: 'instagram'`)
```json
{ "hook": "...", "bullets": ["..."], "cta": "..." }
```
Prompt engineering: ONE share trigger angle (information asymmetry / validation / consequence), exact numbers from analysis, loop anchor on last bullet (echoes hook for replay), share-first CTA targeting specific audience type.

### YouTube Video (`platform: 'youtube'`)
```json
{
  "hook": "scripted 30-45s opening",
  "sections": [{ "title": "...", "points": ["..."] }],
  "conclusion": "scripted 30-45s closing"
}
```
Prompt engineering: analytical deep-dive (not news reading), 4-5 sections (What/Why/Mechanism/So What/Honest Take), hook and conclusion scripted word-for-word, sections are talking points for natural delivery.

---

## Deployment branching (inline vs QStash)

`/api/analyze` decides at request time:
- `QSTASH_TOKEN` set **and** host is not loopback/private → publish to QStash with callback URL
- Otherwise → inline fire-and-forget, self-callback to `http://127.0.0.1:$PORT/api/analyze?isCallback=true`

Localhost/private IP detection forces inline even if token is set. QStash is not yet wired to `/api/analytics` or `/api/social-script` — those run synchronously.

---

## Critical conventions and gotchas

**No auto-analysis.** The analytics page does NOT auto-trigger on mount. Topics load in a "pending" state. User must click "Analyze Topics (N)" in the sticky bar. This is intentional — batch analysis on Tuesday gives Phase 2 the full week's context for relative social scoring.

**Episode name lives in `/analytics` only.** It was removed from Topic Discovery. The `?episode=` URL param is no longer passed from Topic Discovery to Analytics. Episode naming happens in the analytics page input, used only when generating the script.

**Override persistence.** `platform_override` is written to the DB via `saveOverride()` server action on click. Not session-only. Overridden topics always appear in the shortlist regardless of threshold.

**`getAnalyzableUpdates` filter.** Returns `status === 'selected'` OR has `analysis_json`. Intentionally excludes bare pending rows (no analysis, not selected) — those belong in Topic Discovery, not Analytics.

**Defensive JSON parsing in `/api/analyze` callback.** Strips well-formed and orphan `<think>` tags, drops prose before first `{`, falls back to regex extraction if JSON is truncated by `finish_reason=length`. Don't simplify — Llama-70B output is genuinely messy with long outputs.

**`week_id` stamping.** Set automatically on every `saveUpdate()` call using ISO week format (`YYYY-WNN`). Existing rows were backfilled via migration SQL. Required for the YouTube concept date range picker.

**Social scripts table constraint.** Platform values are `'instagram'` and `'youtube'` only — not `'youtube_short'`. Unique constraint on `(update_id, platform)`.

**Status is derived, not stored.** `episodeStatus()` in `app/lib/episodeStatus.ts` infers status from `script_text` presence + `analysis_json.status`. No status column on `episodes`.

**TTS timeout.** `@seepine/edge-tts` timeout overridden to 5 minutes for long scripts. `maxDuration` is 300s. Match both if changing.

**Server actions** use service-role key. Never return Supabase clients — return plain data only.

---

## Environment variables

**Required:**
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NVIDIA_API_KEY`
- `TAVILY_API_KEY`

**For production (Render):**
- `QSTASH_URL`
- `QSTASH_TOKEN`
- `QSTASH_CURRENT_SIGNING_KEY`
- `QSTASH_NEXT_SIGNING_KEY`

**Optional:**
- `PORT` — defaults to 3000, used for self-callback URL construction on Render

---

## Local dev

```bash
npm install
cp .env.example .env   # fill in keys
npm run dev            # Next.js + Turbopack
```

Open `http://localhost:3000`. QStash auto-bypassed on localhost even if token is set.
