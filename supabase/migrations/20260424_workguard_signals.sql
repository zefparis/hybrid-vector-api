-- WorkGuard behavioral signals — fire-and-forget ingestion table.
-- Written by POST /api/signals.

CREATE TABLE IF NOT EXISTS workguard_signals (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     text        NOT NULL,
  source      text        NOT NULL,
  batch       jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Query patterns: recent rows, filter by channel or source.
CREATE INDEX IF NOT EXISTS idx_workguard_signals_created_at
  ON workguard_signals (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workguard_signals_channel_created
  ON workguard_signals (channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workguard_signals_source_created
  ON workguard_signals (source, created_at DESC);
