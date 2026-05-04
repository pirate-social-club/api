CREATE TABLE IF NOT EXISTS community_health_counts (
    community_id TEXT PRIMARY KEY,
    total_views BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL
);
