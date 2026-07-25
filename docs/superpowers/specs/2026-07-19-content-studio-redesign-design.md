# The TechX Studio — Multi-Platform Content Expansion & IA Redesign

## Summary

The app currently runs one linear weekly flow (scrape → research → podcast script → audio) with Instagram Reel / YouTube Video generation and a per-topic research brief bolted on as secondary pages. This design turns it into a hub-and-spoke content studio: every researched topic becomes a production hub that can independently produce a podcast segment, a Reel, a YouTube Video, a LinkedIn post, a WhatsApp update, and an X post — and a new Dashboard gives a single view of production status across all of them. The app is renamed **The TechX Studio** (brand: **The TechX**).

## Background

Current pipeline (see `AGENTS.md`): paste URLs → `/api/scrape` saves rows to `updates` (stamped with `week_id`) → user selects topics for the week → `/api/analytics` runs a two-phase pass (Phase 1: per-topic Tavily + Mistral research brief → `analysis_json`; Phase 2: one batch Mistral call scoring all topics for Reel/Video worthiness → `social_score`, `recommended_platform`) → Script Studio turns selected topics into a weekly podcast script + TTS audio → Episodes archives finished episodes. A separate Social page shows a cross-topic, score-ranked shortlist for generating Instagram Reel / YouTube Video scripts via `/api/social-script`.

This design adds LinkedIn, WhatsApp, and X as three more per-topic outputs generated from the same `analysis_json` brief, and restructures navigation so topics — not a single linear flow — are the organizing unit.

## Naming

- **Brand:** The TechX
- **App name:** The TechX Studio
- Update `app/layout.tsx` metadata title (currently `"TechX TV — Podcast Studio"`) and the Sidebar logo block (currently `"TechX TV"` / `"Podcast Studio"` in `app/components/Sidebar.tsx`) to reflect the new name. No other rebrand work (colors, logo mark, domain) is in scope here.

## Goals

- Reuse the existing research brief (`analysis_json`) to generate LinkedIn, WhatsApp, and X content per topic, on demand.
- Give the app a home view that shows production status across every output type per topic, instead of requiring the user to check multiple pages.
- Keep the existing AI-scored Reel/Video curation workflow intact and untouched — the new platforms are explicitly not scored or gated.
- Rename the app to match its new scope.

## Non-Goals

- No auto-publishing or OAuth integration with LinkedIn/WhatsApp/X — copy-paste only, per earlier decision.
- No AI scoring/gating for LinkedIn/WhatsApp/X — they are always available, button-triggered, per earlier decision.
- No thread support for X — single tweet only, per earlier decision.
- No new LLM vendor — stays on NVIDIA NIM Mistral Large 3, per earlier decision (ruled out swapping to Gemini despite the reference n8n workflow using it).
- No visual rebrand beyond text (logo mark, color palette, favicon) unless raised separately.
- No test suite exists in this repo today; this design does not introduce one. QA is manual (see Testing/QA Plan).

## Information Architecture

### New navigation

| Nav label | Route | Was |
|---|---|---|
| Dashboard | `/` | *(new — was Topic Discovery)* |
| Discover | `/discover` | Topic Discovery, was at `/` |
| Productions | `/productions` | Social, was at `/social` |
| Podcast | `/podcast` | Script Studio, was at `/script-studio` |
| Episodes | `/episodes` | unchanged |

The per-topic workspace (below) is reached by clicking a topic card — it is not a nav item.

`Settings` is removed from the sidebar footer. It has linked to a non-existent `/settings` page since before this design (a known dead link — see `[[project-techx-tv-known-issues]]`); since the sidebar is being rebuilt here anyway, the cleanest fix is to drop the link rather than carry a 404 into the new design. It can be re-added when there's an actual settings screen to point it at.

Old routes (`/script-studio`, `/social`) get a `next.config.js` redirect to their new paths so existing bookmarks/browser history don't 404 — this is a single-operator tool, so this is a convenience for Teja, not SEO.

### Dashboard (`/`)

The new home page: a grid/list of topic cards for the current week (with a toggle to view all weeks), each showing:

- Title, source, research status (✓ once `analysis_json` is populated)
- Social score + recommended platform badge (e.g. "🎬 Reel · 8.2"), when scored
- A status chip per output: Reel, Video, LinkedIn, WhatsApp, X, Podcast — filled/checked once a corresponding `social_scripts` row (or, for Podcast, `updates.episode_id`) exists
- Click → opens that topic's workspace at `/topics/[id]`

Default sort: current week, `social_score` descending, falling back to `created_at`. A search/filter bar is a nice-to-have, not required for v1.

### Per-topic workspace (`/topics/[id]`)

Replaces the per-topic portions of the current Analytics page. Tabs:

- **Research** — the existing editable brief fields (summary, why now, key facts, bigger picture, honest take), the score + recommended-platform badge, and the existing `platform_override` control. This is today's `TopicAnalysisCard` content, relocated.
- **Reel & Video** — existing Instagram/YouTube script generation (`/api/social-script`), unchanged behavior, just re-hosted here instead of on the Social page. Still respects `recommended_platform` / `platform_override`.
- **LinkedIn**, **WhatsApp**, **X** — one tab each. Each tab has: an optional short note textarea ("angle or emphasis — optional"), a Generate button, and once generated, an editable text box (same editable-field pattern as the Research tab) with a Copy button and a char counter for X. Regenerate overwrites the stored result (upsert, not append).

If a topic has no `analysis_json` yet, the LinkedIn/WhatsApp/X and Reel/Video tabs are disabled with a prompt to run research first — these platforms are downstream of the brief, not independent of it.

### Productions (`/productions`)

Unchanged from today's Social page in ranking logic: cross-topic, score-ranked view for Reel/Video specifically (threshold slider, shortlist/ignored drawer). This stays because its entire purpose is comparing topics against each other, which the per-topic workspace doesn't do. LinkedIn/WhatsApp/X never appear here — they have no ranking to browse.

One change from today: actual script generation (the `ReelScriptCard`/`VideoScriptCard` generate actions) moves to the Reel & Video tab of `/topics/[id]` — Productions becomes a read-only ranked list that link-throughs to a topic's workspace to generate or view. This avoids two separate UI implementations of the same generate action against the same `social_scripts` row.

### Podcast (`/podcast`) and Episodes (`/episodes`)

Unchanged functionality; renamed nav label only for Podcast (was Script Studio).

## New Platform Content Generation

### Scope & gating model

LinkedIn, WhatsApp, and X are per-topic, button-triggered, ungated. This is a deliberate contrast with Reel/Video, which are scored by Phase 2 of `/api/analytics` specifically because only one Reel and one Video can realistically be produced per batch — the score decides which topic "wins." LinkedIn/WhatsApp/X have no such constraint: any topic with a brief can produce all three, any time, at negligible cost.

### Prompts

Adapted from Teja's existing n8n workflow (validated in production), restructured to consume `analysis_json` directly instead of a live URL re-scrape, and split into three independent calls instead of one combined call — because a button-per-platform UI shouldn't force-generate platforms the user didn't ask for.

**LinkedIn** (`app/api/social-script/route.ts`, new `linkedin` branch):

```
You are a professional content strategist for TechX TV (Teja's tech channel), writing
LinkedIn posts that translate pre-researched tech stories into sharp, credible commentary
— not press-release summaries.

CONTEXT YOU'LL RECEIVE: topic title, a pre-researched brief (summary, why this matters now,
key facts, the bigger picture, an honest take, source links), and optionally a short note
from Teja on angle/emphasis — follow it if present.

RULES:
- Hook first: open with the single most interesting claim, tension, or surprising fact from
  the brief — never a generic opener like "Exciting news!"
- Tone: professional, insightful. Short paragraphs (3-4 sentences), scannable on mobile.
- Ground every claim in the provided brief. Never invent facts, numbers, quotes, or people.
- Weave in the "honest take" somewhere — that's Teja's actual opinion, not neutral reporting.
- Use 2-4 emojis naturally (💡 🚀 📈 ⚡) — never more than one per paragraph.
- End with a question to invite comments only if it fits naturally; don't force it.
- Include the source URL on its own line near the end.
- Include 3-5 hashtags — mix broad (#AI #TechNews) with topic-specific ones.
- No <think> tags, no prose, no markdown — return only the JSON object below.

Return ONLY:
{ "content": "the full LinkedIn post, ready to copy-paste" }
```

**WhatsApp** (new `whatsapp` branch):

```
You are writing a WhatsApp tech-update broadcast for TechX TV (Teja's channel) — the kind
of message worth forwarding straight to a group because it's actually worth their 15 seconds.

CONTEXT: topic title, pre-researched brief, optional note from Teja.

RULES:
- No greeting, no "Hey everyone" — open directly with a punchy, topic-specific hook line.
- Casual, direct, scannable — short lines, not paragraphs. Use line breaks and emojis the
  way a real WhatsApp message actually reads.
- Deliver the real facts from the brief. Do NOT hype it up, do not oversell, do not use
  clickbait phrasing the research doesn't support.
- Keep it short — a few lines, not an essay.
- End with the source URL on its own line.
- No <think> tags, no prose, no markdown — return only the JSON object below.

Return ONLY:
{ "content": "the full WhatsApp message, ready to copy-paste" }
```

**X** (new `x` branch):

```
You are writing a single X post for TechX TV (Teja's channel) — sharp, opinionated, built
to stop a scroll.

CONTEXT: topic title, pre-researched brief, optional note.

RULES:
- Hard limit: 280 characters total, including hashtags and emoji. Count carefully.
- Open with a bold hook or contrarian angle — one clear takeaway, not a summary of everything.
- Prefer the "honest take" angle over neutral restating — this should read as an opinion,
  not a headline.
- Line breaks are fine if they help readability within the limit.
- 1-2 emojis max. 1-2 hashtags max — no hashtag stuffing.
- Do NOT include a URL — X posts run link-free by design.
- Avoid salesy language ("game-changer", "you won't believe"). Aim for curiosity, not hype.
- No <think> tags, no prose, no markdown — return only the JSON object below.

Return ONLY:
{ "content": "the full X post text, ready to copy-paste, under 280 characters" }
```

Each user prompt is built from `analysis_json` fields (`summary`, `whyNow`, `keyFacts`, `biggerPicture`, `honestTake`, `sources`), the topic `title` and `url`, and the optional note — same assembly pattern already used for the Instagram/YouTube prompts.

### Route architecture

`app/api/social-script/route.ts` currently branches Instagram vs. YouTube with two large inline prompt constants and an if/else. Adding three more platforms the same way makes the file unmanageable. Refactor to a small platform registry:

```ts
const PLATFORMS: Record<Platform, {
  systemPrompt: string;
  buildUserPrompt: (topic: Topic, note?: string) => string;
  parseResponse: (raw: string) => Record<string, unknown>;
}> = { instagram: {...}, youtube: {...}, linkedin: {...}, whatsapp: {...}, x: {...} };
```

The `POST` handler resolves `PLATFORMS[platform]`, builds the prompt, calls NIM, parses (same `<think>`-strip + regex-JSON-fallback defensive parsing already used here and in `youtube-concept/route.ts`), and upserts into `social_scripts`. This keeps each platform's prompt and parsing self-contained and testable in isolation, and adding a future platform means adding one registry entry, not another if/else branch.

These are synchronous request/response calls (single topic, single short post) — no fire-and-forget/self-callback needed, unlike the weekly podcast script generation. `maxDuration` around 60s is enough headroom.

### Data model changes

Reuse `social_scripts` rather than adding new tables:

- Widen the `platform` check constraint: `'instagram' | 'youtube' | 'linkedin' | 'whatsapp' | 'x'`.
- `script_json` shape for the three new platforms: `{ content: string }`.
- Add a nullable `note` text column to `social_scripts` — stores whatever the user typed before generating, so it's visible if they revisit or regenerate later.
- Existing unique constraint `(update_id, platform)` already gives the right upsert-on-regenerate behavior.

This is also the natural point to fold `supabase/schema.sql` up to date — it's currently missing `social_score`, `recommended_platform`, `social_reasoning`, `platform_override`, `week_id` on `updates`, and the `social_scripts`/`youtube_concepts` tables entirely (known issue, on hold until now). Since this work already needs a migration touching `social_scripts`, bundling the full schema.sql catch-up into the same migration avoids a second separate cleanup pass later.

## Data Flow

1. `/discover`: paste URLs → `/api/scrape` → `updates` rows (`status: pending`, `week_id` stamped).
2. User selects topics for the week (existing behavior).
3. `/api/analytics` runs: Phase 1 (per-topic Tavily + Mistral) → `analysis_json`; Phase 2 (batch Mistral) → `social_score`, `recommended_platform`, `social_reasoning`.
4. `/` (Dashboard): topics render as cards; status chips are derived (not stored) from `analysis_json` presence, `social_scripts` rows per platform, and `episode_id` presence.
5. `/topics/[id]`: Research tab shows/edits the brief; Reel & Video tab calls `/api/social-script?platform=instagram|youtube`; LinkedIn/WhatsApp/X tabs call the same route with the new platform values plus the optional note.
6. `/productions`: unchanged cross-topic Reel/Video ranking, reading the same `social_score`/`social_scripts` data.
7. `/podcast` → `/episodes`: unchanged weekly digest flow.

## Error Handling

Follows existing conventions rather than introducing new ones:

- NIM calls wrapped in try/catch; on failure, no `social_scripts` row is written (or `status: 'failed'` if a row was already pending), and the tab shows an inline error with a Retry button — since generation is a single on-demand button click, retry is just clicking again, no queue/backoff logic needed.
- JSON parsing stays defensive: strip `<think>` tags, regex-match the outermost `{...}`, `JSON.parse`, matching the pattern already used in `social-script` and `youtube-concept` routes.
- Dashboard status chips degrade gracefully: a topic with no brief yet just shows unfilled chips, not an error state.

## Testing / QA Plan

No automated test suite exists in this repo; this is manual QA, consistent with how the rest of the app is validated:

- Generate each of LinkedIn/WhatsApp/X for 2-3 real topics with varied content; check tone, length (X ≤280 chars), and that facts match the brief (no invented details).
- Regenerate a platform and confirm it overwrites (upsert), not duplicates.
- Confirm Dashboard status chips update immediately after each generation.
- Confirm Productions page behavior (threshold, shortlist/ignored) is unchanged.
- Confirm `/script-studio` and `/social` redirect correctly to `/podcast` and `/productions`.
- Confirm mobile nav (sidebar drawer) still works with the updated link set.
- Run the schema.sql migration against a fresh Supabase project and confirm the app boots clean (closes the stale-schema known issue).

## Out of Scope

- Auto-publishing / OAuth to LinkedIn, WhatsApp Business API, or X API.
- AI scoring or gating for LinkedIn/WhatsApp/X.
- X threads, Instagram content from this route (the form-checkbox artifact in the reference n8n workflow was a no-op and isn't being carried over).
- Switching any generation to Google Gemini.
- Visual/brand redesign beyond text renames (logo, color palette, favicon).
- A `/settings` page — the dead link is removed, not replaced with a real page.
