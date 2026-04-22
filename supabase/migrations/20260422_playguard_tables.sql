-- ── PlayGuard: tenant auth ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS playguard_tenants (
  tenant_id   TEXT        PRIMARY KEY,
  api_key     TEXT        NOT NULL UNIQUE,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the default demo tenant
INSERT INTO playguard_tenants (tenant_id, api_key, name)
VALUES ('playguard-demo', 'playguard-key-2026', 'PlayGuard Demo')
ON CONFLICT (tenant_id) DO NOTHING;

-- ── PlayGuard: scan events ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS playguard_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT        NOT NULL REFERENCES playguard_tenants(tenant_id),
  player_id       TEXT,
  board_id        TEXT,
  platform        TEXT,
  verdict         TEXT        NOT NULL CHECK (verdict IN ('ALLOWED', 'MINOR', 'BANNED')),
  age_low         SMALLINT,
  age_high        SMALLINT,
  is_minor        BOOLEAN     NOT NULL DEFAULT false,
  ban_detected    BOOLEAN     NOT NULL DEFAULT false,
  ban_face_id     TEXT,
  ban_similarity  REAL,
  face_confidence REAL,
  scanned_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_playguard_events_tenant_scanned
  ON playguard_events (tenant_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_playguard_events_verdict
  ON playguard_events (tenant_id, verdict);

-- ── PlayGuard: ban registry ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS playguard_bans (
  face_id     TEXT        NOT NULL,
  tenant_id   TEXT        NOT NULL REFERENCES playguard_tenants(tenant_id),
  external_id TEXT        NOT NULL,
  reason      TEXT        NOT NULL,
  operator    TEXT        NOT NULL,
  banned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (face_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_playguard_bans_tenant
  ON playguard_bans (tenant_id, banned_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE playguard_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE playguard_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE playguard_bans    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "app_backend full access on playguard_tenants"
  ON playguard_tenants FOR ALL TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY "app_backend full access on playguard_events"
  ON playguard_events FOR ALL TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY "app_backend full access on playguard_bans"
  ON playguard_bans FOR ALL TO app_backend USING (true) WITH CHECK (true);
