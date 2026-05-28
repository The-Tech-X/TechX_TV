# TechX TV — agent guide

## This is NOT the Next.js you know

Next.js 16 has breaking changes — APIs, conventions, and file structure may differ from your training data. Before writing Next-specific code, read the relevant guide in `node_modules/next/dist/docs/` and heed deprecation notices.

## What this app is

A four-page Next.js 16 (App Router, Turbopack, React 19) studio for producing a weekly tech podcast end-to-end: capture URLs, curate stories, analyze each one with web search + LLM reasoning, generate a single flowing host script (English or Tenglish), and synthesize audio. State lives in Supabase Postgres; audio lives in a Supabase Storage bucket. Deploys to Render free tier (no per-request timeout) with optional Upstash QStash for serverless platforms.

## End-to-end flow

```
/  (Topic Discovery)           paste URLs → /api/scrape → updates table
                               select stories, name episode, choose lang
                               ↓
/analytics?episode=…&lang=…    auto-fires /api/analytics per topic:
                                 Tavily web search → Mistral Large 3 →
                                 {summary, whyNow, keyFacts[], biggerPicture, honestTake, sources}
                               user can edit any field, re-analyze, include/exclude
                               ↓ "Generate Script"
/api/analyze (POST)            builds system+user prompt, calls Llama-3.1-70B on NIM
                               writes episodes.script_text, links updates → episode
                               ↓
/script-studio                 edit script, click Generate Audio
                               ↓
/api/tts                       Edge TTS (en-US-AndrewNeural) → MP3 → Supabase Storage
                                                                ↓
/episodes                      browse archive, plays audio inline
```

## Stack

| Layer            | Choice                                                            |
| ---------------- | ----------------------------------------------------------------- |
| Framework        | Next.js 16 (App Router, Turbopack), React 19, TypeScript 5         |
| Styling          | Tailwind v4, Lucide icons, custom dark theme                       |
| DB + Storage     | Supabase (Postgres + `audio` storage bucket)                       |
| Web search       | Tavily (`search_depth: advanced`, 6 results, includes answer)      |
| Analyst LLM      | `mistralai/mistral-large-3-675b-instruct-2512` via NVIDIA NIM      |
| Script writer    | `meta/llama-3.1-70b-instruct` via NVIDIA NIM (both English + Tenglish) |
| TTS              | `@seepine/edge-tts` → `en-US-AndrewNeural` (Microsoft Edge TTS)    |
| Article scrape   | `jsdom` + `@mozilla/readability`                                   |
| Background queue | Upstash QStash — only used on serverless hosts (auto-detected)     |

Note: older docs mention Sarvam-M for Tenglish. That was tried and dropped — see the comment block at `app/api/analyze/route.ts:255`. Both languages now run on Llama-3.1-70B; only the system prompt differs.

## Project layout

```
app/
  page.tsx                 Topic Discovery — URL input, scrape, select, episode bar
  analytics/page.tsx       Per-topic editable briefs (Suspense wrapper around AnalyticsInner)
  script-studio/page.tsx   Episode list + script editor + audio generation + retry button
  episodes/page.tsx        Read-only archive, inline audio player
  layout.tsx               Dark shell, ambient blobs, Sidebar mount
  components/Sidebar.tsx   Desktop static / mobile slide-in nav
  lib/episodeStatus.ts     Derive 'ready'|'generating'|'failed'|'pending' from row fields
  actions/
    updates.ts             Topic CRUD + analysis save + getAnalyzableUpdates filter
    episodes.ts            Episode read/save + getTopicsForEpisodeRetry (failed-run replay)
  api/
    scrape/route.ts        URL → Readability → {title, source, url, content}
    analytics/route.ts     topicIds[] → Tavily + Mistral → analysis_json (300s maxDuration)
    analyze/route.ts       topics+briefs → Llama → episodes.script_text (60s + 15min undici dispatcher)
    tts/route.ts           text → Edge TTS → upload mp3 → episodes.audio_url (300s)
supabase/schema.sql        Tables, trigger, RLS policies, migration notes
render.yaml                Render Blueprint (free plan, Singapore region, secrets via UI)
.env.example               Required + optional env vars
```

## Data model (Supabase)

Two tables, both RLS-locked to service-role.

**`updates`** — one row per topic.
- `id uuid pk` · `title text` · `url text` · `source text` · `content text`
- `analysis_json jsonb` — `{summary, whyNow, keyFacts[], biggerPicture, honestTake, sources:[{title,url}]}`
- `status update_status` — `'pending' | 'selected' | 'done'`
- `episode_id uuid → episodes(id)` (set when topics get linked to a finished script)
- `created_at`, `updated_at` (auto-bumped by `set_updated_at()` trigger)

**`episodes`** — one row per generated podcast.
- `id uuid pk` · `week_id text unique` (user-supplied like `"Ep-01"`)
- `script_text text` — finished script (presence ⇒ ready)
- `analysis_json jsonb` — overloaded with run status: `{status: 'generating'|'failed', error?, model, language, topic_ids[], started_at|failed_at}`
- `audio_url text` — public URL in the `audio` bucket
- `created_at`, `updated_at`

Episode status is **derived**, not stored — see `app/lib/episodeStatus.ts`. There's no `status` column on `episodes` and there's no `published_status`, `week_number`, or embedded `topics` array. Earlier specs that listed those are wrong.

## API route conventions

- All routes are `runtime = 'nodejs'`. Long ones set `maxDuration` explicitly.
- `/api/analyze` is split into two POSTs to itself:
  - First call (no `isCallback`): kicks off NIM, returns `{success, status}` immediately. Records `analysis_json.status='generating'` on the episode row.
  - Self-callback (`?isCallback=true`): parses NIM response, strips `<think>` tags, recovers truncated JSON, writes `script_text`, links `updates.episode_id`.
- Long NIM calls use a **custom undici dispatcher** with 15-minute `headersTimeout`/`bodyTimeout` because Llama-70B with 8K tokens regularly takes 6–10 min to first byte. The dispatcher is scoped to the NIM fetch only — Tavily and Supabase keep snappy defaults.
- Retry policy: 4 attempts total (initial + 3) at 5s/15s/45s backoff, but only for transient errors (`UND_ERR_*`, `ECONNRESET`, `ETIMEDOUT`, `AbortError`, `EAI_AGAIN`, `ENOTFOUND`, HTTP 429, HTTP 5xx). See `isTransientError` and `TRANSIENT_ERROR_CODES` at the top of the file.

## Deployment branching (inline vs QStash)

`/api/analyze` decides at request time:

- `QSTASH_TOKEN` set **and** request `host` is not loopback/private → publish job to QStash with `callback` URL; serverless-friendly.
- Otherwise → run NIM fetch inline (fire-and-forget Promise), self-callback to `http://127.0.0.1:$PORT/api/analyze?isCallback=true`. This is what Render uses.

Localhost/private-IP detection (`localhost`, `127.*`, `10.*`, `192.168.*`, `172.16–31.*`, `::1`) forces the inline branch even if `QSTASH_TOKEN` is set, because QStash can't reach loopback.

## Critical conventions and gotchas

- **Status overload.** Both episode run-state ('generating'/'failed') and topic curation state ('pending'/'selected'/'done') live in JSONB / an enum — there's no schema migration just to add a status column. When changing run-state semantics, update `app/lib/episodeStatus.ts` and both writers in `/api/analyze`.
- **Script JSON parsing is defensive.** The callback strips well-formed and orphan `<think>...</think>`, drops prose before the first `{`, parses, and falls back to a regex-recovered `script` string if JSON is truncated by `finish_reason=length`. A recovery note is stored on `analysis_json.recovery_note`. Don't simplify this — model output is genuinely messy.
- **Language routing.** The frontend sends `language: 'english' | 'tenglish'` to `/api/analyze`; the route picks one of two giant system prompts but always uses Llama-70B. The user prompt's "topic briefs" block stays the same.
- **`getAnalyzableUpdates`** intentionally returns currently-selected topics **plus** previously-analyzed pending topics — so the analytics page lets users opt back into work from earlier sessions. Don't broaden it to all rows.
- **TTS timeout.** `@seepine/edge-tts` default timeout is 60s; we override to 5 min for long scripts. Match `maxDuration` if you change one.
- **Storage.** `audio` bucket must exist and be public. The TTS route does `upsert: true` on a timestamped filename, so it never collides.
- **Server actions** in `app/actions/*` use the Supabase service-role key. Never expose them via shape-shifting (e.g. returning a Supabase client) — only return plain data.
- **No tests yet.** When you touch the analyze pipeline, manually run the flow end-to-end (Topic Discovery → Analytics → Script Studio) at least once before declaring done.

## Environment variables

Required: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NVIDIA_API_KEY`, `TAVILY_API_KEY`.
Optional: `QSTASH_TOKEN` (only for serverless), `PORT` (defaults to 3000, used only by the local self-callback).

## Local dev

```bash
npm install
cp .env.example .env   # fill in keys
npm run dev            # next dev, Turbopack
```

Open `http://localhost:3000`. Inline branch is automatic on localhost; QStash is bypassed even if the token is set.
