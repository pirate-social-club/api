ALTER TABLE royalty_claim_events
    ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'failed'));

ALTER TABLE royalty_claim_events
    ADD COLUMN verified_at TEXT;

ALTER TABLE royalty_claim_events
    ADD COLUMN verification_error TEXT;

CREATE INDEX IF NOT EXISTS idx_royalty_claim_events_status
    ON royalty_claim_events (status, created_at ASC);
