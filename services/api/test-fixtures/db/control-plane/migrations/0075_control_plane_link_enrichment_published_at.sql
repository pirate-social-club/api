ALTER TABLE link_enrichments
    ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
