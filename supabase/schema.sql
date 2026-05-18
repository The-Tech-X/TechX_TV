-- supabase/schema.sql
-- Run this fresh, or apply the migration notes for existing installs.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enum for update status (includes 'done' for processed topics)
CREATE TYPE update_status AS ENUM ('pending', 'selected', 'done');

-- Episodes Table (must exist before updates FK)
CREATE TABLE episodes (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    week_id     TEXT        NOT NULL UNIQUE,
    script_text TEXT,
    analysis_json JSONB,
    audio_url   TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Updates Table
CREATE TABLE updates (
    id            UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    title         TEXT            NOT NULL,
    url           TEXT,
    source        TEXT,
    content       TEXT,
    -- Per-topic deep analysis (Tavily web search + Mistral Large reasoning).
    -- Shape: { summary, whyNow, keyFacts: string[], biggerPicture, honestTake, sources?: [{title,url}] }
    -- Filled by /api/analytics, edited by the user on /analytics page, consumed by /api/analyze.
    analysis_json JSONB,
    status        update_status   DEFAULT 'pending',
    episode_id    UUID            REFERENCES episodes(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ     DEFAULT NOW(),
    updated_at    TIMESTAMPTZ     DEFAULT NOW()
);

-- updated_at trigger function
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers
CREATE TRIGGER set_updates_updated_at
BEFORE UPDATE ON updates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_episodes_updated_at
BEFORE UPDATE ON episodes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Row Level Security
ALTER TABLE updates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all for service role on updates"
ON updates FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Enable all for service role on episodes"
ON episodes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── Migration (for existing databases) ──────────────────────────────────────
-- If you already have the tables, run these individually in Supabase SQL editor:
--
-- ALTER TYPE update_status ADD VALUE IF NOT EXISTS 'done';
--
-- ALTER TABLE updates
--   ADD COLUMN IF NOT EXISTS episode_id    UUID REFERENCES episodes(id) ON DELETE SET NULL,
--   ADD COLUMN IF NOT EXISTS analysis_json JSONB;
--
-- CREATE INDEX IF NOT EXISTS idx_updates_episode_id ON updates(episode_id);
-- ─────────────────────────────────────────────────────────────────────────────
