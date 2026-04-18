-- ============================================================
-- CTN (Cognitive Trust Network) — Supabase Schema
-- ============================================================

-- -----------------------------------------------------------
-- 1. ctn_nodes — Registered network participants
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ctn_nodes (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_name text        NOT NULL,
    cname_domain     text        NOT NULL UNIQUE,
    tier             text        NOT NULL DEFAULT 'shadow',  -- shadow | standard | enterprise
    status           text        NOT NULL DEFAULT 'pending', -- pending | active | suspended
    api_key          text        NOT NULL UNIQUE,
    joined_at        timestamptz          DEFAULT now(),
    last_seen        timestamptz,

    CONSTRAINT ctn_nodes_tier_check   CHECK (tier   IN ('shadow', 'standard', 'enterprise')),
    CONSTRAINT ctn_nodes_status_check CHECK (status IN ('pending', 'active', 'suspended'))
);

-- -----------------------------------------------------------
-- 2. ctn_threats — Anonymised threat patterns shared across nodes
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ctn_threats (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern_hash   text        NOT NULL,                         -- SHA-256, anonymised
    vector_type    text        NOT NULL,                         -- bot | spoofing | replay | cognitive_attack
    severity       int         NOT NULL CHECK (severity BETWEEN 1 AND 5),
    source_node_id uuid        REFERENCES ctn_nodes(id) ON DELETE SET NULL,
    detected_at    timestamptz DEFAULT now(),
    expires_at     timestamptz,                                  -- TTL 72 h

    CONSTRAINT ctn_threats_vector_type_check CHECK (
        vector_type IN ('bot', 'spoofing', 'replay', 'cognitive_attack')
    )
);

-- -----------------------------------------------------------
-- 3. ctn_scores — Cross-node composite trust scores
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ctn_scores (
    id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    user_hash           text           NOT NULL,           -- SHA-256 of user identifier
    score               numeric(5, 2)  NOT NULL CHECK (score BETWEEN 0 AND 100),
    confidence          numeric(4, 2)           CHECK (confidence BETWEEN 0 AND 1),
    contributing_nodes  int            DEFAULT 1,
    updated_at          timestamptz    DEFAULT now()
);

-- -----------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ctn_threats_vector_type_detected_at
    ON ctn_threats (vector_type, detected_at);

CREATE INDEX IF NOT EXISTS idx_ctn_scores_user_hash
    ON ctn_scores (user_hash);

CREATE INDEX IF NOT EXISTS idx_ctn_nodes_status_tier
    ON ctn_nodes (status, tier);

-- -----------------------------------------------------------
-- Row Level Security (RLS)
-- service_role : full write access
-- authenticated : read-only
-- -----------------------------------------------------------
ALTER TABLE ctn_nodes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctn_threats ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctn_scores  ENABLE ROW LEVEL SECURITY;

-- ctn_nodes
CREATE POLICY "ctn_nodes_service_write"
    ON ctn_nodes FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "ctn_nodes_authenticated_read"
    ON ctn_nodes FOR SELECT
    TO authenticated
    USING (true);

-- ctn_threats
CREATE POLICY "ctn_threats_service_write"
    ON ctn_threats FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "ctn_threats_authenticated_read"
    ON ctn_threats FOR SELECT
    TO authenticated
    USING (true);

-- ctn_scores
CREATE POLICY "ctn_scores_service_write"
    ON ctn_scores FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "ctn_scores_authenticated_read"
    ON ctn_scores FOR SELECT
    TO authenticated
    USING (true);
