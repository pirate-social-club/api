-- Make EFP sponsorship recovery durable across UTC-day boundaries and prevent
-- repeated UI attempts from preparing multiple bootstrap slots for the same
-- semantic follow action.

ALTER TABLE efp_follow_write_intents
    ADD COLUMN semantic_attempt_key TEXT,
    ADD COLUMN sponsorship_budget_date DATE,
    ADD COLUMN sponsorship_review_after TIMESTAMPTZ;

ALTER TABLE efp_follow_write_intents
    DROP CONSTRAINT efp_follow_write_intents_status_check;

ALTER TABLE efp_follow_write_intents
    ADD CONSTRAINT efp_follow_write_intents_status_check CHECK (
        status IN (
            'prepared',
            'submitting',
            'submitted',
            'confirmed',
            'reflected',
            'expired',
            'failed',
            'manual_review'
        )
    );

-- Existing reservations were created on the intent's last transition into
-- submitting. Preserve that UTC budget day so later recovery releases and
-- consumes the same ledger row rather than whichever day recovery runs.
UPDATE efp_follow_write_intents
SET sponsorship_budget_date = CAST(updated_at AS DATE),
    sponsorship_review_after = updated_at + INTERVAL '24 hours'
WHERE sponsorship_reserved_transaction_count > 0;

ALTER TABLE efp_follow_write_intents
    ADD CONSTRAINT efp_follow_write_intent_reservation_has_budget_date CHECK (
        sponsorship_reserved_transaction_count = 0
        OR sponsorship_budget_date IS NOT NULL
    );

CREATE UNIQUE INDEX idx_efp_follow_write_intents_active_semantic_attempt
    ON efp_follow_write_intents(semantic_attempt_key)
    WHERE semantic_attempt_key IS NOT NULL
      AND status IN ('prepared', 'submitting', 'submitted', 'confirmed', 'manual_review');

CREATE INDEX idx_efp_follow_write_intents_expiry_recovery
    ON efp_follow_write_intents(status, expires_at, sponsorship_review_after)
    WHERE status IN ('prepared', 'submitting');
