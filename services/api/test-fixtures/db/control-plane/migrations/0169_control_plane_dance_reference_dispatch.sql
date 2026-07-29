-- Durable, bounded dispatch coordination for asynchronous reference extraction.
-- Modal owns compute only; the control plane remains the source of retry state.

ALTER TABLE dance_choreography_revisions
    ADD COLUMN reference_dispatch_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dance_choreography_revisions
    ADD COLUMN reference_dispatch_claim_token TEXT;
ALTER TABLE dance_choreography_revisions
    ADD COLUMN reference_dispatch_claim_expires_at TIMESTAMPTZ;
ALTER TABLE dance_choreography_revisions
    ADD COLUMN reference_dispatch_id TEXT;
ALTER TABLE dance_choreography_revisions
    ADD COLUMN reference_dispatched_at TIMESTAMPTZ;
ALTER TABLE dance_choreography_revisions
    ADD COLUMN reference_next_dispatch_at TIMESTAMPTZ;
ALTER TABLE dance_choreography_revisions
    ADD COLUMN reference_dispatch_last_error TEXT;

UPDATE dance_choreography_revisions
SET reference_next_dispatch_at = created_at
WHERE status = 'processing';

ALTER TABLE dance_choreography_revisions
    ADD CONSTRAINT dance_reference_dispatch_state_check CHECK (
      (
        reference_dispatch_attempt_count BETWEEN 0 AND 5
        AND (
          (reference_dispatch_claim_token IS NULL
            AND reference_dispatch_claim_expires_at IS NULL)
          OR
          (reference_dispatch_claim_token IS NOT NULL
            AND reference_dispatch_claim_expires_at IS NOT NULL
            AND status = 'processing')
        )
        AND (
          reference_dispatch_id IS NULL
          OR (
            reference_dispatched_at IS NOT NULL
            AND reference_dispatch_attempt_count > 0
          )
        )
        AND (
          status = 'processing'
          OR (
            reference_dispatch_claim_token IS NULL
            AND reference_dispatch_claim_expires_at IS NULL
            AND reference_next_dispatch_at IS NULL
          )
        )
      ) IS TRUE
    );

CREATE INDEX idx_dance_reference_dispatch_due
    ON dance_choreography_revisions(reference_next_dispatch_at, created_at)
    WHERE status = 'processing'
      AND reference_next_dispatch_at IS NOT NULL;
