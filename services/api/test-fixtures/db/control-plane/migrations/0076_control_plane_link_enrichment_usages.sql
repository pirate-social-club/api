CREATE TABLE IF NOT EXISTS link_enrichment_usages (
    normalized_url TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    link_enrichment_id TEXT,
    snapshot_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (normalized_url, community_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_link_enrichment_usages_normalized_url
    ON link_enrichment_usages(normalized_url, updated_at DESC);

