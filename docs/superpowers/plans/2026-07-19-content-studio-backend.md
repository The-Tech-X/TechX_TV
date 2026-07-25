# Content Studio Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every researched topic the ability to generate a LinkedIn post, a WhatsApp update, and an X post — on top of the existing Instagram Reel and YouTube Video generation — reusing the same `analysis_json` brief, on the same NVIDIA NIM Mistral Large 3 model, saved to a widened `social_scripts` table.

**Architecture:** Refactor the single-route, two-branch `/api/social-script` endpoint into a five-entry platform registry (`app/api/social-script/prompts.ts`) consumed by a slimmed-down route handler. Widen `social_scripts` to accept the three new platform values and support upsert-on-regenerate. Fold the DB's real, drifted-from-`schema.sql` shape back into `schema.sql` as a single idempotent file, since this migration already has to touch the same table.

**Tech Stack:** Next.js 16 API routes (Node runtime), `@supabase/supabase-js`, NVIDIA NIM (`mistralai/mistral-large-3-675b-instruct-2512`), Supabase Postgres.

## Global Constraints

- Model stays NVIDIA NIM Mistral Large 3 for all five platforms — no new LLM vendor.
- LinkedIn, WhatsApp, X are per-topic, button-triggered, ungated — no AI scoring applies to them (scoring stays scoped to Reel/Video via existing `social_score`/`recommended_platform`).
- X output is a single tweet (≤280 characters), never a thread.
- No auto-publish/OAuth integration — output is copy-paste text only.
- No automated test suite exists in this repo (no Jest/Vitest configured) and this plan does not introduce one — verification is manual via `curl` and the Supabase SQL editor, matching how the rest of the app is validated today.
- **Do not run `git commit` on the user's behalf at any point in this plan.** The user commits everything themselves. Each task ends with the changes staged and ready for review, not committed.
- This plan is backend-only. The Dashboard, per-topic workspace UI, and nav/rebrand changes are covered by the companion plan `docs/superpowers/plans/2026-07-19-content-studio-frontend.md`, which depends on this one being done first (it calls the routes this plan builds).

---

### Task 1: Fold the live database shape back into `schema.sql`, widened for new platforms

`supabase/schema.sql` currently only defines the original 2-table schema (`updates`, `episodes`). The running app depends on five more columns on `updates` and two more tables (`social_scripts`, `youtube_concepts`) that were added directly in the Supabase SQL editor and never saved to a file — a known, previously-flagged drift issue. This task fixes that permanently by making `schema.sql` a single idempotent file that's safe to run against either a brand-new Supabase project or the existing live one, and widens `social_scripts.platform` for the three new platforms in the same pass.

**Files:**
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `updates.social_score` (numeric), `updates.recommended_platform` (text), `updates.social_reasoning` (text), `updates.platform_override` (text), `updates.week_id` (text) — all already in live use, now captured in the file. `social_scripts` table with columns `id, update_id, youtube_concept_id, platform, script_json, status, note, created_at, updated_at`, `platform` constrained to `'instagram' | 'youtube' | 'linkedin' | 'whatsapp' | 'x'`, unique on `(update_id, platform)`. `youtube_concepts` table with columns `id, date_from, date_to, update_ids, concept_json, chosen_option, status, created_at, updated_at`. Task 3 depends on the widened `platform` constraint and the unique constraint (for upsert) existing before it runs.

- [ ] **Step 1: Replace the full contents of `supabase/schema.sql`**

```sql
-- supabase/schema.sql
-- Idempotent — safe to run top-to-bottom on a fresh Supabase project OR
-- against the existing TechX Studio database. Every statement is guarded
-- (IF NOT EXISTS / DROP-then-CREATE / catalog checks), so re-running this
-- file after a schema change just applies whatever's missing.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enum for update status
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'update_status') THEN
    CREATE TYPE update_status AS ENUM ('pending', 'selected', 'done');
  END IF;
END $$;

-- Episodes Table (must exist before updates FK)
CREATE TABLE IF NOT EXISTS episodes (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    week_id       TEXT        NOT NULL UNIQUE,
    script_text   TEXT,
    analysis_json JSONB,
    audio_url     TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Updates Table — one row per scraped news topic
CREATE TABLE IF NOT EXISTS updates (
    id            UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    title         TEXT            NOT NULL,
    url           TEXT,
    source        TEXT,
    content       TEXT,
    -- Shape: { summary, whyNow, keyFacts: string[], biggerPicture, honestTake, sources?: [{title,url}] }
    analysis_json JSONB,
    status        update_status   DEFAULT 'pending',
    episode_id    UUID            REFERENCES episodes(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ     DEFAULT NOW(),
    updated_at    TIMESTAMPTZ     DEFAULT NOW()
);

-- Phase 2 batch scoring (/api/analytics) — Reel/Video worthiness only.
-- These were added to the live DB via ad-hoc Supabase SQL editor migrations
-- and are being folded back into this file for the first time.
ALTER TABLE updates ADD COLUMN IF NOT EXISTS social_score          NUMERIC;
ALTER TABLE updates ADD COLUMN IF NOT EXISTS recommended_platform  TEXT;
ALTER TABLE updates ADD COLUMN IF NOT EXISTS social_reasoning      TEXT;
ALTER TABLE updates ADD COLUMN IF NOT EXISTS platform_override     TEXT;
-- e.g. "2026-W23", stamped at insert time by app/actions/updates.ts
ALTER TABLE updates ADD COLUMN IF NOT EXISTS week_id               TEXT;

CREATE INDEX IF NOT EXISTS idx_updates_episode_id ON updates(episode_id);
CREATE INDEX IF NOT EXISTS idx_updates_week_id    ON updates(week_id);

-- updated_at trigger function (must exist before any trigger references it)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updates_updated_at ON updates;
CREATE TRIGGER set_updates_updated_at
BEFORE UPDATE ON updates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_episodes_updated_at ON episodes;
CREATE TRIGGER set_episodes_updated_at
BEFORE UPDATE ON episodes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Row Level Security
ALTER TABLE updates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'updates' AND policyname = 'Enable all for service role on updates') THEN
    CREATE POLICY "Enable all for service role on updates"
    ON updates FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'episodes' AND policyname = 'Enable all for service role on episodes') THEN
    CREATE POLICY "Enable all for service role on episodes"
    ON episodes FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Social scripts — generated per-topic content for every downstream platform.
-- Existed live already for 'instagram'/'youtube' (ad-hoc migration); this
-- file now defines it for the first time and widens it for the three new
-- platforms.
CREATE TABLE IF NOT EXISTS social_scripts (
    id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    update_id           UUID        REFERENCES updates(id) ON DELETE CASCADE,
    youtube_concept_id  UUID,
    platform            TEXT        NOT NULL,
    -- Instagram: {hook, bullets[], cta}
    -- YouTube:   {hook, sections:[{title,points[]}], conclusion}
    -- LinkedIn / WhatsApp / X: {content}
    script_json         JSONB       NOT NULL,
    status              TEXT        NOT NULL DEFAULT 'done',
    -- Optional angle/emphasis note the user typed before generating
    note                TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE social_scripts ADD COLUMN IF NOT EXISTS note TEXT;

DROP TRIGGER IF EXISTS set_social_scripts_updated_at ON social_scripts;
CREATE TRIGGER set_social_scripts_updated_at
BEFORE UPDATE ON social_scripts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE social_scripts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'social_scripts' AND policyname = 'Enable all for service role on social_scripts') THEN
    CREATE POLICY "Enable all for service role on social_scripts"
    ON social_scripts FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Widen the platform constraint to cover LinkedIn/WhatsApp/X. Drops any
-- existing platform-related CHECK first (there may be one from the
-- original ad-hoc 'instagram'/'youtube'-only migration) so this is safe
-- to re-run regardless of what it was named.
DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'social_scripts'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%platform%'
  LOOP
    EXECUTE format('ALTER TABLE social_scripts DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE social_scripts
  ADD CONSTRAINT social_scripts_platform_check
  CHECK (platform IN ('instagram', 'youtube', 'linkedin', 'whatsapp', 'x'));

-- One script per (topic, platform) — regenerating overwrites rather than
-- duplicating. (update_id IS NULL rows — synthesized YouTube-concept
-- scripts — fall outside this constraint since Postgres treats NULLs as
-- distinct; that matches today's behavior for that path.)
DO $$
BEGIN
  ALTER TABLE social_scripts
    ADD CONSTRAINT social_scripts_update_id_platform_key UNIQUE (update_id, platform);
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'social_scripts_update_id_platform_key already exists, skipping';
END $$;

-- YouTube video concepts — multi-week synthesis across several topics
CREATE TABLE IF NOT EXISTS youtube_concepts (
    id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    date_from      DATE        NOT NULL,
    date_to        DATE        NOT NULL,
    update_ids     UUID[]      NOT NULL DEFAULT '{}',
    concept_json   JSONB       NOT NULL,
    chosen_option  TEXT,
    status         TEXT        NOT NULL DEFAULT 'concept_ready',
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_youtube_concepts_updated_at ON youtube_concepts;
CREATE TRIGGER set_youtube_concepts_updated_at
BEFORE UPDATE ON youtube_concepts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE youtube_concepts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'youtube_concepts' AND policyname = 'Enable all for service role on youtube_concepts') THEN
    CREATE POLICY "Enable all for service role on youtube_concepts"
    ON youtube_concepts FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- social_scripts.youtube_concept_id FK — added now that youtube_concepts exists
DO $$
BEGIN
  ALTER TABLE social_scripts
    ADD CONSTRAINT social_scripts_youtube_concept_id_fkey
    FOREIGN KEY (youtube_concept_id) REFERENCES youtube_concepts(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'social_scripts_youtube_concept_id_fkey already exists, skipping';
END $$;
```

- [ ] **Step 2: Run it against the live database**

Paste the full file into the Supabase project's SQL Editor and run it. It's safe against the live DB even though most tables/columns already exist — every statement is a no-op where things already match.

- [ ] **Step 3: Verify**

Run in the same SQL Editor:

```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'social_scripts' ORDER BY column_name;
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'social_scripts'::regclass;
```

Expected: the first query lists `id, update_id, youtube_concept_id, platform, script_json, status, note, created_at, updated_at`. The second lists `social_scripts_platform_check` with `CHECK ((platform = ANY (ARRAY['instagram'::text, 'youtube'::text, 'linkedin'::text, 'whatsapp'::text, 'x'::text])))` and `social_scripts_update_id_platform_key` as a `UNIQUE` constraint on `(update_id, platform)`.

- [ ] **Step 4: Stage for review**

```bash
git add supabase/schema.sql
```

Do not commit — leave staged for the user to review and commit.

---

### Task 2: Extract the platform prompt registry

`app/api/social-script/route.ts` currently hard-codes two ~65-line prompt constants inline with an if/else. Adding three more the same way makes the file unmanageable. This task moves prompt content into its own file as a registry, so Task 3's route handler shrinks to orchestration only, and adding a future platform later means adding one registry entry, not another branch.

**Files:**
- Create: `app/api/social-script/prompts.ts`

**Interfaces:**
- Produces: `Platform` type (`'instagram' | 'youtube' | 'linkedin' | 'whatsapp' | 'x'`), `UpdateRow` type, `PLATFORMS: Record<Platform, { systemPrompt: string; maxTokens: number; buildUserPrompt: (update: UpdateRow, note?: string) => string }>`. Task 3 imports all three from this file.

- [ ] **Step 1: Create `app/api/social-script/prompts.ts`**

```ts
export type Platform = 'instagram' | 'youtube' | 'linkedin' | 'whatsapp' | 'x';

export type UpdateRow = {
  id: string;
  title: string;
  url: string | null;
  source: string | null;
  social_reasoning: string | null;
  analysis_json: {
    summary?: string;
    whyNow?: string;
    keyFacts?: string[];
    biggerPicture?: string;
    honestTake?: string;
    sources?: { title?: string; url?: string }[];
  } | null;
};

function formatAnalysis(update: UpdateRow): string {
  const a = update.analysis_json ?? {};
  const facts = Array.isArray(a.keyFacts) ? a.keyFacts.map((f) => `• ${f}`).join('\n') : '';
  return [
    `TOPIC: ${update.title}`,
    `SOURCE: ${update.source ?? 'Unknown'}`,
    update.url ? `URL: ${update.url}` : '',
    '',
    `Summary: ${a.summary ?? ''}`,
    `Why Now: ${a.whyNow ?? ''}`,
    `Key Facts:\n${facts}`,
    `Bigger Picture: ${a.biggerPicture ?? ''}`,
    `Honest Take: ${a.honestTake ?? ''}`,
  ].filter(Boolean).join('\n');
}

function withNote(note?: string): string {
  return note ? `\nNOTE FROM TEJA (follow this angle/emphasis): ${note}` : '';
}

const INSTAGRAM_SYSTEM_PROMPT = `You are a short-form video script writer for TechX TV — a tech news channel watched by a broad audience: CS students, developers, founders, product managers, tech professionals, and anyone genuinely curious about where technology is going. The host is Teja.

Your job is to write an Instagram Reel script that is CURIOSITY-DRIVEN and SHARE-DRIVEN. In 2026, shares are the top Instagram ranking signal — more than saves, more than likes. Every structural decision must answer one question: "Would someone who follows tech send this to a friend, classmate, or colleague right now?"

Teja's voice on social: the same person as always — curious, direct, no hype — but compressed. Like a smart friend who just found out something and has 30 seconds to tell you about it before you leave the room.

═══ AUDIENCE ═══
Not just engineers. Anyone curious about tech. A student learning about AI. A founder tracking industry shifts. A product manager understanding what just changed. A professional who wants to stay informed. Write so all of them feel like they just learned something their circle doesn't know yet. No assumed coding knowledge. Plain language that respects intelligence.

═══ HOOK (scripted word-for-word, 3 seconds) ═══
One line. No setup. No context. The single most surprising, contradictory, or counterintuitive fact from this story.

The hook must do TWO things simultaneously:
1. Create a CURIOSITY GAP — a specific claim so surprising they have to watch to understand it
2. Trigger a SHARE IMPULSE — the immediate feeling of "someone I know needs to see this"

The share impulse in tech content comes from one of three angles. READ THE STORY and identify WHICH ONE fits best. Use ONLY that angle — do not blend all three:
- INFORMATION ASYMMETRY: something just changed and most people don't know yet. Hook sounds like: "Most people in tech still don't know [X happened]."
- VALIDATION: something confirms what many have been sensing but couldn't articulate. Hook sounds like: "Turns out [widely felt frustration] was always [surprising truth]."
- CONSEQUENCE: something will directly affect their field, career, or tools — they need to warn someone. Hook sounds like: "[Specific company/product] just [action] — and [your audience] are affected."

USE the exact numbers, names, and dates from the analysis. "A major tech company raised prices" will never be shared. "OpenAI just raised API costs by 15% overnight" gets screenshotted. Specificity is the mechanism of sharing.

The hook is a statement, not a question — unless the question is so provocative it cannot be ignored.

═══ BODY (5–7 talking points) ═══
Each bullet is one natural spoken sentence — the way you'd explain this to a smart friend who follows tech but isn't a specialist. Short. Sharp. No jargon without a one-phrase explanation.

Structure each bullet to progressively build INFORMATION ASYMMETRY: by bullet 4, the viewer should feel they know something their network doesn't. That feeling is what triggers the share.

Each bullet must either:
- Deliver a fact so specific it feels like insider knowledge (use exact numbers, names, amounts from the analysis)
- Reframe something the viewer thought they understood
- Advance the "so what" — what this means for people, companies, or the industry

THE LAST BULLET IS THE LOOP ANCHOR: take the exact subject from the hook and frame it with the new weight the viewer now has from watching. Example: if the hook is about a price increase, the last bullet is about what that price increase now means for the viewer's decisions. When the video replays, this bullet flows naturally back into the hook. Instagram counts replays. A seamless loop stretches watch time without the viewer noticing.

BANNED PHRASES: "basically", "essentially", "in other words", "as we can see", "it's important to note", "it's worth mentioning". Just say the thing.

═══ CTA (scripted word-for-word, 3–5 seconds) ═══
SHARE-FIRST. Always. Not "save this." Not "follow for more."

The CTA must feel like a genuine recommendation — target the specific type of person in the audience who would benefit most from knowing this. Make it feel like Teja is recommending it to someone they actually know, not performing engagement for an algorithm.

Examples of the RIGHT register (never copy these — build from the real story):
- "Send this to anyone building in this space — they need to know."
- "Forward this to a friend who still thinks [common misconception]."
- "Share this with someone who uses [relevant product/tool] — this affects them directly."

═══ RULES ═══
- Total spoken time: 30–45 seconds max. Every second must earn its place.
- Never open with "Hey guys", "In today's video", "Welcome", or any filler.
- No hype words: game-changer, revolutionary, incredible, massive, insane, huge, groundbreaking.
- Use the EXACT numbers, names, company names, and dates from the analysis. Never paraphrase into vagueness.
- Pick ONE share trigger angle. The hook is built around that angle and nothing else.
- Accessible to anyone interested in tech — no assumed technical background.

Return ONLY this JSON (no prose, no markdown, no <think> tags):
{
  "hook": "word-for-word scripted hook line",
  "bullets": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"],
  "cta": "word-for-word scripted CTA"
}`;

const YOUTUBE_VIDEO_SYSTEM_PROMPT = `You are a YouTube video script writer for TechX TV — a tech channel watched by a broad audience: CS students, developers, founders, product managers, tech professionals, and anyone genuinely curious about technology. The host is Teja.

Your job is to write a full-length YouTube video script (8–15 minutes when spoken). This is NOT a news read. This is NOT a summary. This is a deep, analytical perspective piece — Teja exploring why something matters, what caused it, and what it means for people following tech. Think: a thoughtful journalist who has an opinion, not an anchor reading headlines.

Teja's voice: the smartest friend you have who happens to follow tech closely. Direct, curious, no hedging, no hype. Explains things the way you'd explain them to someone intelligent who isn't a specialist. Has genuine opinions and commits to them. Sentences vary wildly in length — a long analytical sentence, then a short sharp one. Rhetorical questions used sparingly but effectively.

═══ AUDIENCE ═══
Anyone curious about tech. A student learning the landscape. A founder understanding market shifts. A product manager figuring out what this changes for their roadmap. A tech professional staying informed. A curious person who follows the industry. Write so they all leave genuinely understanding something — not just having heard about it.

═══ THE SCRIPT STRUCTURE ═══

Your script has four types of content. Return them as labeled sections.

[HOOK — scripted word-for-word, 30–45 seconds]
This is the most important writing in the entire script. It is NOT an intro. It does not say "welcome" or "today we're covering." It drops the viewer directly into the most surprising, provocative, or consequential angle on this topic.

The hook must establish the TENSION that the rest of the video resolves. Ask the question the viewer didn't know they had. Make a claim that seems almost too specific to be real. Open a loop that can only be closed by watching the whole video.

Use the exact numbers, names, and facts from the analysis. The hook should feel like Teja grabbing your arm and saying "wait, you need to hear this."

[SECTIONS — 4 to 5 analytical sections, each with a clear title and talking points]
These are not news bullets. Each section explores one analytical angle. Together they build a complete understanding of why this story matters. Suggested framework (adapt as needed for the story):

Section 1 — THE WHAT: What actually happened. Specific. No press release language. Include key facts, numbers, names, dates. Get the viewer fully oriented in 1-2 minutes.

Section 2 — THE WHY: Why did this happen NOW? What competitive pressure, market shift, technological threshold, or strategic calculation caused this? This is the section most tech coverage skips. Don't skip it. The "why now" is often the most interesting part.

Section 3 — THE MECHANISM (or THE HOW): How does this actually work? What's the underlying technology, business model, or dynamic that makes this possible or significant? Explain it simply — the student who just started CS should be able to follow, but the founder should find it valuable.

Section 4 — THE SO WHAT: What does this mean for different people? For students in this space? For people building on top of this? For existing players in the industry? For the person watching this video? Make the implications specific and concrete, not abstract.

Section 5 — THE HONEST TAKE (include if the story warrants a strong opinion): Teja's actual view. Is this a genuine shift or is it hype? Is the industry overreacting or underreacting? What's the thing nobody's saying? Commit to a view. No hedging. "Hype" is a valid take. "This is genuinely scary and not enough people are talking about it" is a valid take.

Each talking point in a section is one spoken sentence or a very short two-sentence beat. Natural, conversational, dense with information. Not a bullet list being read aloud — a person talking.

[CONCLUSION — scripted word-for-word, 30–45 seconds]
The conclusion does three things:
1. Calls back to the hook — resolves the tension or question opened at the start
2. Lands Teja's final take — one clean statement of what the viewer should now understand or watch for
3. Closes the loop — no "smash that like button." A genuine closing thought that feels like the natural end of a real conversation.

═══ RULES ═══
- This is a full analytical video, not a news recap. Every section should give the viewer something they couldn't get from reading a headline.
- Use EXACT numbers, names, company names, model versions, and dates from the analysis. Never paraphrase specifics into vagueness — specificity builds credibility.
- No hype words: game-changer, revolutionary, incredible, massive, insane, groundbreaking, unprecedented.
- No filler openers: "Welcome back", "Hey everyone", "Today we're going to be talking about", "In this video".
- When a technical term is necessary, define it in the same sentence — one plain phrase is enough. Never assume prior knowledge but never condescend either.
- Sections should feel like natural conversation, not a structured report. Teja talks. He doesn't present.
- The hook and conclusion are scripted word-for-word. The sections are talking points — specific enough to guide delivery but with room for natural conversation.

Return ONLY this JSON (no prose, no markdown, no <think> tags):
{
  "hook": "scripted word-for-word 30-45 second opening — full sentences, as Teja would actually say them",
  "sections": [
    {
      "title": "Section title",
      "points": ["talking point 1", "talking point 2", "talking point 3", "talking point 4"]
    }
  ],
  "conclusion": "scripted word-for-word 30-45 second closing — full sentences, as Teja would actually say them"
}`;

const LINKEDIN_SYSTEM_PROMPT = `You are a professional content strategist for TechX TV (Teja's tech channel), writing LinkedIn posts that translate pre-researched tech stories into sharp, credible commentary — not press-release summaries.

CONTEXT YOU'LL RECEIVE: topic title, a pre-researched brief (summary, why this matters now, key facts, the bigger picture, an honest take, source links), and optionally a short note from Teja on angle/emphasis — follow it if present.

RULES:
- Hook first: open with the single most interesting claim, tension, or surprising fact from the brief — never a generic opener like "Exciting news!"
- Tone: professional, insightful. Short paragraphs (3-4 sentences), scannable on mobile.
- Ground every claim in the provided brief. Never invent facts, numbers, quotes, or people.
- Weave in the "honest take" somewhere — that's Teja's actual opinion, not neutral reporting.
- Use 2-4 emojis naturally (💡 🚀 📈 ⚡) — never more than one per paragraph.
- End with a question to invite comments only if it fits naturally; don't force it.
- Include the source URL on its own line near the end.
- Include 3-5 hashtags — mix broad (#AI #TechNews) with topic-specific ones.
- No <think> tags, no prose, no markdown — return only the JSON object below.

Return ONLY:
{ "content": "the full LinkedIn post, ready to copy-paste" }`;

const WHATSAPP_SYSTEM_PROMPT = `You are writing a WhatsApp tech-update broadcast for TechX TV (Teja's channel) — the kind of message worth forwarding straight to a group because it's actually worth their 15 seconds.

CONTEXT: topic title, pre-researched brief, optional note from Teja.

RULES:
- No greeting, no "Hey everyone" — open directly with a punchy, topic-specific hook line.
- Casual, direct, scannable — short lines, not paragraphs. Use line breaks and emojis the way a real WhatsApp message actually reads.
- Deliver the real facts from the brief. Do NOT hype it up, do not oversell, do not use clickbait phrasing the research doesn't support.
- Keep it short — a few lines, not an essay.
- End with the source URL on its own line.
- No <think> tags, no prose, no markdown — return only the JSON object below.

Return ONLY:
{ "content": "the full WhatsApp message, ready to copy-paste" }`;

const X_SYSTEM_PROMPT = `You are writing a single X post for TechX TV (Teja's channel) — sharp, opinionated, built to stop a scroll.

CONTEXT: topic title, pre-researched brief, optional note.

RULES:
- Hard limit: 280 characters total, including hashtags and emoji. Count carefully.
- Open with a bold hook or contrarian angle — one clear takeaway, not a summary of everything.
- Prefer the "honest take" angle over neutral restating — this should read as an opinion, not a headline.
- Line breaks are fine if they help readability within the limit.
- 1-2 emojis max. 1-2 hashtags max — no hashtag stuffing.
- Do NOT include a URL — X posts run link-free by design.
- Avoid salesy language ("game-changer", "you won't believe"). Aim for curiosity, not hype.
- No <think> tags, no prose, no markdown — return only the JSON object below.

Return ONLY:
{ "content": "the full X post text, ready to copy-paste, under 280 characters" }`;

export const PLATFORMS: Record<Platform, {
  systemPrompt: string;
  maxTokens: number;
  buildUserPrompt: (update: UpdateRow, note?: string) => string;
}> = {
  instagram: {
    systemPrompt: INSTAGRAM_SYSTEM_PROMPT,
    maxTokens: 1500,
    buildUserPrompt: (update) => `Write an Instagram Reel script for this tech story.

${formatAnalysis(update)}

Platform context: ${update.social_reasoning ?? ''}

Write the hook, bullets, and CTA. Return only the JSON.`,
  },
  youtube: {
    systemPrompt: YOUTUBE_VIDEO_SYSTEM_PROMPT,
    maxTokens: 1500,
    buildUserPrompt: (update) => `Write a full-length YouTube video script for this tech story.

${formatAnalysis(update)}

Platform context: ${update.social_reasoning ?? ''}

Write the hook, sections, and conclusion. Return only the JSON.`,
  },
  linkedin: {
    systemPrompt: LINKEDIN_SYSTEM_PROMPT,
    maxTokens: 700,
    buildUserPrompt: (update, note) => `Write a LinkedIn post for this tech story.

${formatAnalysis(update)}${withNote(note)}

Return the post. Return only the JSON.`,
  },
  whatsapp: {
    systemPrompt: WHATSAPP_SYSTEM_PROMPT,
    maxTokens: 400,
    buildUserPrompt: (update, note) => `Write a WhatsApp update for this tech story.

${formatAnalysis(update)}${withNote(note)}

Return the message. Return only the JSON.`,
  },
  x: {
    systemPrompt: X_SYSTEM_PROMPT,
    maxTokens: 250,
    buildUserPrompt: (update, note) => `Write an X post for this tech story.

${formatAnalysis(update)}${withNote(note)}

Return the post. Return only the JSON.`,
  },
};
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `app/api/social-script/prompts.ts` (pre-existing unrelated errors elsewhere, if any, are not this task's concern).

- [ ] **Step 3: Stage for review**

```bash
git add app/api/social-script/prompts.ts
```

---

### Task 3: Refactor the route to use the registry, fix insert→upsert, accept `note`

**Files:**
- Modify: `app/api/social-script/route.ts` (full rewrite of the file — it currently contains the two prompt constants inline; Task 2 already extracted them)

**Interfaces:**
- Consumes: `Platform`, `UpdateRow`, `PLATFORMS` from `./prompts` (Task 2).
- Produces: `POST /api/social-script` accepting `{ updateId?: string, platform: Platform, note?: string, conceptOverride?: { conceptId: string, prompt: string } }`, returning `{ success: true, script: Record<string, unknown>, id: string }` on success or `{ error: string }` on failure. This is the contract the frontend plan's Quick Posts panel and Reel/Video tab (in `docs/superpowers/plans/2026-07-19-content-studio-frontend.md`) call directly.

- [ ] **Step 1: Replace the full contents of `app/api/social-script/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { PLATFORMS, type Platform } from './prompts';

export const maxDuration = 120;
export const runtime = 'nodejs';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const NIM_URL       = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MISTRAL_MODEL = 'mistralai/mistral-large-3-675b-instruct-2512';

function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && value in PLATFORMS;
}

export async function POST(req: Request) {
  try {
    const { updateId, platform, note, conceptOverride } = await req.json();

    if (!platform) {
      return NextResponse.json({ error: 'platform is required' }, { status: 400 });
    }
    if (!isPlatform(platform)) {
      return NextResponse.json(
        { error: `platform must be one of: ${Object.keys(PLATFORMS).join(', ')}` },
        { status: 400 }
      );
    }
    if (!process.env.NVIDIA_API_KEY) {
      return NextResponse.json({ error: 'NVIDIA_API_KEY missing' }, { status: 500 });
    }

    let userPrompt: string;
    const saveUpdateId: string | null = updateId || null;
    const saveConceptId: string | null = conceptOverride?.conceptId || null;

    if (conceptOverride?.prompt) {
      // YouTube concept path — prompt built by the UI
      userPrompt = conceptOverride.prompt;
    } else {
      if (!updateId) {
        return NextResponse.json({ error: 'updateId is required for single-topic scripts' }, { status: 400 });
      }

      const { data: update, error: fetchErr } = await supabase
        .from('updates')
        .select('*')
        .eq('id', updateId)
        .single();
      if (fetchErr || !update) {
        return NextResponse.json({ error: 'Update not found' }, { status: 404 });
      }
      if (!update.analysis_json) {
        return NextResponse.json({ error: 'Run analytics on this topic first' }, { status: 400 });
      }

      userPrompt = PLATFORMS[platform].buildUserPrompt(update, note);
    }

    const { systemPrompt, maxTokens } = PLATFORMS[platform];

    const res = await fetch(NIM_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        temperature: 0.6,
        max_tokens: maxTokens,
      }),
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(`NIM ${res.status}: ${(data.error?.message || JSON.stringify(data)).slice(0, 200)}`);
    }

    let raw: string = data.choices?.[0]?.message?.content ?? '';
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    const jsonStr = match ? match[0] : raw;

    let scriptJson: any;
    try {
      scriptJson = JSON.parse(jsonStr);
    } catch {
      throw new Error('Failed to parse script JSON from model');
    }

    // Upsert (not insert) — regenerating a platform for a topic overwrites
    // the existing row instead of erroring on the (update_id, platform)
    // unique constraint. Concept-derived scripts (update_id null) fall
    // outside the constraint since Postgres treats NULLs as distinct, so
    // they insert fresh each time, same as before this change.
    const { data: saved, error: saveErr } = await supabase
      .from('social_scripts')
      .upsert(
        {
          update_id:          saveUpdateId,
          youtube_concept_id: saveConceptId,
          platform,
          script_json:        scriptJson,
          status:             'done',
          note:               note || null,
        },
        { onConflict: 'update_id,platform' }
      )
      .select()
      .single();

    if (saveErr) console.error('[SocialScript] Save error:', saveErr);

    return NextResponse.json({ success: true, script: scriptJson, id: saved?.id });
  } catch (e: any) {
    console.error('[SocialScript] Error:', e);
    return NextResponse.json({ error: e?.message || 'Script generation failed' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `app/api/social-script/route.ts`.

- [ ] **Step 3: Regression-test the two platforms that already worked, against a real topic**

Start the dev server (`npm run dev`) in one terminal. In another, find a real topic that already has a brief:

```bash
# Run in the Supabase SQL editor, or via psql if you have a connection string:
# SELECT id, title FROM updates WHERE analysis_json IS NOT NULL LIMIT 1;
```

Take the returned `id` and run:

```bash
curl -s -X POST http://localhost:3000/api/social-script \
  -H "Content-Type: application/json" \
  -d '{"updateId":"<id-from-query-above>","platform":"instagram"}' | jq
```

Expected: HTTP 200, `{"success":true,"script":{"hook":"...","bullets":[...],"cta":"..."},"id":"<uuid>"}`. Repeat with `"platform":"youtube"` — expect `{"hook":...,"sections":[...],"conclusion":...}`. This confirms the registry refactor didn't change existing Reel/Video behavior.

- [ ] **Step 4: Stage for review**

```bash
git add app/api/social-script/route.ts
```

---

### Task 4: Verify the three new platforms end-to-end

Confirms LinkedIn, WhatsApp, and X generate correctly, respect the note field, stay within X's character limit, and that regenerating overwrites rather than duplicating.

**Files:** none (verification only — no code changes).

**Interfaces:** none produced; this task validates Tasks 1–3 together.

- [ ] **Step 1: Generate all three for a real topic**

Using the same `<id-from-query-above>` from Task 3:

```bash
curl -s -X POST http://localhost:3000/api/social-script \
  -H "Content-Type: application/json" \
  -d '{"updateId":"<id-from-query-above>","platform":"linkedin","note":"emphasize the pricing angle"}' | jq

curl -s -X POST http://localhost:3000/api/social-script \
  -H "Content-Type: application/json" \
  -d '{"updateId":"<id-from-query-above>","platform":"whatsapp"}' | jq

curl -s -X POST http://localhost:3000/api/social-script \
  -H "Content-Type: application/json" \
  -d '{"updateId":"<id-from-query-above>","platform":"x"}' | jq
```

Expected: each returns `{"success":true,"script":{"content":"..."},"id":"<uuid>"}`. Manually read each `content` value and confirm: LinkedIn is professional with a source URL and hashtags; WhatsApp opens with no greeting and ends with the URL; X's `content` string is ≤280 characters (`echo -n "<content>" | wc -c`) and contains no URL.

- [ ] **Step 2: Verify persistence and upsert behavior**

In the Supabase SQL editor:

```sql
SELECT platform, note, script_json, created_at, updated_at
FROM social_scripts
WHERE update_id = '<id-from-query-above>'
ORDER BY platform;
```

Expected: one row each for `instagram`, `youtube`, `linkedin`, `whatsapp`, `x`; the `linkedin` row's `note` column contains `"emphasize the pricing angle"`.

- [ ] **Step 3: Confirm regenerate overwrites, not duplicates**

Re-run the `linkedin` curl command from Step 1 with a different note (`"note":"more skeptical tone"`), then re-run the Step 2 query. Expected: still exactly one `linkedin` row for this `update_id` — `note` is now `"more skeptical tone"` and `updated_at` is newer than `created_at`. This confirms the upsert fix from Task 3 works and satisfies the frontend plan's "regenerate overwrites" requirement.

- [ ] **Step 4: No commit needed**

This task is verification only. If Steps 1–3 didn't behave as expected, fix the relevant code from Task 2 or 3 before moving to the frontend plan — don't proceed with a broken backend.
