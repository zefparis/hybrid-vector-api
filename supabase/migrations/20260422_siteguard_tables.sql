-- ── SiteGuard: tenant auth ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS siteguard_tenants (
  tenant_id   TEXT        PRIMARY KEY,
  api_key     TEXT        NOT NULL UNIQUE,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO siteguard_tenants (tenant_id, api_key, name)
VALUES ('siteguard-demo', 'siteguard-key-2026', 'SiteGuard Demo')
ON CONFLICT (tenant_id) DO NOTHING;

-- ── SiteGuard: scan events ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS siteguard_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT        NOT NULL REFERENCES siteguard_tenants(tenant_id),
  worker_id        TEXT,
  site_id          TEXT,
  verdict          TEXT        NOT NULL CHECK (verdict IN ('AUTHORIZED','UNAUTHORIZED','BLACKLISTED')),
  blacklist_sim    REAL,
  authorized_sim   REAL,
  face_confidence  REAL,
  scanned_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_siteguard_events_tenant_scanned
  ON siteguard_events (tenant_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_siteguard_events_verdict
  ON siteguard_events (tenant_id, verdict);

CREATE INDEX IF NOT EXISTS idx_siteguard_events_site
  ON siteguard_events (tenant_id, site_id);

-- ── SiteGuard: worker registry ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS siteguard_workers (
  face_id        TEXT        NOT NULL,
  tenant_id      TEXT        NOT NULL REFERENCES siteguard_tenants(tenant_id),
  external_id    TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  role           TEXT        NOT NULL DEFAULT '',
  site_id        TEXT        NOT NULL DEFAULT '',
  certifications JSONB       NOT NULL DEFAULT '[]',
  enrolled_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (face_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_siteguard_workers_tenant
  ON siteguard_workers (tenant_id, enrolled_at DESC);

CREATE INDEX IF NOT EXISTS idx_siteguard_workers_site
  ON siteguard_workers (tenant_id, site_id);

-- ── SiteGuard: blacklist ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS siteguard_blacklist (
  face_id     TEXT        NOT NULL,
  tenant_id   TEXT        NOT NULL REFERENCES siteguard_tenants(tenant_id),
  external_id TEXT        NOT NULL,
  reason      TEXT        NOT NULL,
  operator    TEXT        NOT NULL,
  banned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (face_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_siteguard_blacklist_tenant
  ON siteguard_blacklist (tenant_id, banned_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE siteguard_tenants   ENABLE ROW LEVEL SECURITY;
ALTER TABLE siteguard_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE siteguard_workers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE siteguard_blacklist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "app_backend full access on siteguard_tenants"
  ON siteguard_tenants FOR ALL TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY "app_backend full access on siteguard_events"
  ON siteguard_events FOR ALL TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY "app_backend full access on siteguard_workers"
  ON siteguard_workers FOR ALL TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY "app_backend full access on siteguard_blacklist"
  ON siteguard_blacklist FOR ALL TO app_backend USING (true) WITH CHECK (true);
