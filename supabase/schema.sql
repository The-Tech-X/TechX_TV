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
-- In-flight status for /api/analytics — separate from analysis_json because
-- analysis_json truthiness means "brief is done" elsewhere in the app.
-- Shape: { step: 'searching'|'analyzing'|'failed', query?, sources?: [{title,url}], error?, updated_at }
-- Null once analysis_json is written (success) or left set with step:'failed' on failure.
ALTER TABLE updates ADD COLUMN IF NOT EXISTS analysis_progress     JSONB;
-- Raw Firecrawl scrape results (title/url/content per source), saved as soon
-- as the web search succeeds — independent of whether analysis_json (the
-- Mistral brief) ever completes. WhatsApp/LinkedIn/X posts are generated
-- directly from this via Gemini, skipping the Mistral brief for speed.
-- Shape: [{ title, url, content }]
ALTER TABLE updates ADD COLUMN IF NOT EXISTS scraped_content       JSONB;

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
ALTER TABLE social_scripts ADD COLUMN IF NOT EXISTS error_message TEXT;

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

-- App-wide config editable from /settings (API keys + which model each
-- pipeline stage uses). Read via app/lib/settings.ts, which falls back to
-- the matching env var (and then a hardcoded default) whenever a key has no
-- row here yet — so existing env-var-based deployments keep working
-- unchanged until someone actually saves a value in the UI.
-- Keys in use: nvidia_api_key, firecrawl_api_key, gemini_api_key,
-- nim_analysis_model, nim_podcast_model, gemini_model.
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT        PRIMARY KEY,
    value       TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'app_settings' AND policyname = 'Enable all for service role on app_settings') THEN
    CREATE POLICY "Enable all for service role on app_settings"
    ON app_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
