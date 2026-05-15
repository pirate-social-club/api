CREATE TABLE IF NOT EXISTS materialized_public_feeds (
    cache_key TEXT PRIMARY KEY,
    json_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    refreshed_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    stale_at TIMESTAMPTZ NOT NULL,
    source_version TEXT
);

CREATE INDEX IF NOT EXISTS idx_materialized_public_feeds_expires
    ON materialized_public_feeds(expires_at);

