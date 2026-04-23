-- ── DriveGuard: tenant auth ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS driveguard_tenants (
  tenant_id   TEXT        PRIMARY KEY,
  api_key     TEXT        NOT NULL UNIQUE,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO driveguard_tenants (tenant_id, api_key, name)
VALUES ('driveguard-demo', 'driveguard-key-2026', 'DriveGuard Demo')
ON CONFLICT (tenant_id) DO NOTHING;

-- ── DriveGuard: scan events ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS driveguard_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT        NOT NULL REFERENCES driveguard_tenants(tenant_id),
  driver_id        TEXT,
  vehicle_id       TEXT,
  verdict          TEXT        NOT NULL CHECK (verdict IN ('AUTHORIZED','UNAUTHORIZED','BLACKLISTED')),
  blacklist_sim    REAL,
  authorized_sim   REAL,
  face_confidence  REAL,
  scanned_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driveguard_events_tenant_scanned
  ON driveguard_events (tenant_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_driveguard_events_verdict
  ON driveguard_events (tenant_id, verdict);

CREATE INDEX IF NOT EXISTS idx_driveguard_events_vehicle
  ON driveguard_events (tenant_id, vehicle_id);

-- ── DriveGuard: driver registry ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS driveguard_drivers (
  face_id      TEXT        NOT NULL,
  tenant_id    TEXT        NOT NULL REFERENCES driveguard_tenants(tenant_id),
  external_id  TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  role         TEXT        NOT NULL DEFAULT '',
  vehicle_id   TEXT        NOT NULL DEFAULT '',
  licences     JSONB       NOT NULL DEFAULT '[]',
  enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (face_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_driveguard_drivers_tenant
  ON driveguard_drivers (tenant_id, enrolled_at DESC);

CREATE INDEX IF NOT EXISTS idx_driveguard_drivers_vehicle
  ON driveguard_drivers (tenant_id, vehicle_id);

-- ── DriveGuard: blacklist ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS driveguard_blacklist (
  face_id     TEXT        NOT NULL,
  tenant_id   TEXT        NOT NULL REFERENCES driveguard_tenants(tenant_id),
  external_id TEXT        NOT NULL,
  reason      TEXT        NOT NULL,
  operator    TEXT        NOT NULL,
  banned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (face_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_driveguard_blacklist_tenant
  ON driveguard_blacklist (tenant_id, banned_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE driveguard_tenants   ENABLE ROW LEVEL SECURITY;
ALTER TABLE driveguard_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE driveguard_drivers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE driveguard_blacklist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "app_backend full access on driveguard_tenants"
  ON driveguard_tenants FOR ALL TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY "app_backend full access on driveguard_events"
  ON driveguard_events FOR ALL TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY "app_backend full access on driveguard_drivers"
  ON driveguard_drivers FOR ALL TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY "app_backend full access on driveguard_blacklist"
  ON driveguard_blacklist FOR ALL TO app_backend USING (true) WITH CHECK (true);
