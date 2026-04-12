PRAGMA foreign_keys = ON;

CREATE TABLE community_pricing_policies (
    community_id TEXT PRIMARY KEY,
    regional_pricing_enabled INTEGER NOT NULL CHECK (
        regional_pricing_enabled IN (0, 1)
    ),
    verification_provider_requirement TEXT CHECK (
        verification_provider_requirement IS NULL OR verification_provider_requirement IN ('self')
    ),
    default_tier_key TEXT,
    tiers_json TEXT NOT NULL,
    country_assignments_json TEXT NOT NULL,
    source_template_id TEXT,
    source_template_version TEXT,
    pricing_policy_version TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_pricing_policies_enabled
    ON community_pricing_policies(regional_pricing_enabled, updated_at DESC);
