CREATE TABLE IF NOT EXISTS link_enrichments (
    link_enrichment_id TEXT PRIMARY KEY,
    normalized_url TEXT NOT NULL UNIQUE,
    canonical_url TEXT,
    provider TEXT NOT NULL CHECK (
        provider IN ('firecrawl', 'native', 'manual')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'ready', 'failed', 'unavailable')
    ),
    title TEXT,
    description TEXT,
    publisher TEXT,
    image_url TEXT,
    markdown TEXT,
    summary_json JSONB,
    summary_status TEXT CHECK (
        summary_status IN ('pending', 'ready', 'failed', 'unavailable')
    ),
    summary_model TEXT,
    error TEXT,
    fetched_at TIMESTAMPTZ,
    summarized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_link_enrichments_status
    ON link_enrichments(status, updated_at DESC);

