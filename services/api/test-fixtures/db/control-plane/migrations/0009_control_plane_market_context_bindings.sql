PRAGMA foreign_keys = ON;

CREATE TABLE claim_market_bindings (
    claim_market_binding_id TEXT PRIMARY KEY,
    normalized_claim_hash TEXT NOT NULL,
    normalized_claim_text TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    provider_market_id TEXT NOT NULL,
    provider_event_id TEXT,
    question TEXT NOT NULL,
    market_url TEXT NOT NULL,
    resolve_date TEXT,
    -- Provider-specific cached snapshot or lookup hints used to reduce repeated
    -- external discovery calls for the same normalized claim cluster.
    snapshot_payload_json TEXT,
    snapshot_at TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'archived')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_claim_market_bindings_claim_provider_market
    ON claim_market_bindings(normalized_claim_hash, provider_key, provider_market_id);

CREATE INDEX idx_claim_market_bindings_claim_status
    ON claim_market_bindings(normalized_claim_hash, status, updated_at DESC);
