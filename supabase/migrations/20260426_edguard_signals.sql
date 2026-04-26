-- EdGuard behavioral signals — fire-and-forget ingestion table.
-- Written by POST /api/signals when body.source = 'edguard'.

CREATE TABLE IF NOT EXISTS edguard_signals (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text,
  channel     text,
  source      text,
  events      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Query patterns: recent rows, filter by tenant / channel / source.
CREATE INDEX IF NOT EXISTS idx_edguard_signals_created_at
  ON edguard_signals (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_edguard_signals_tenant_created
  ON edguard_signals (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_edguard_signals_channel_created
  ON edguard_signals (channel, created_at DESC);
