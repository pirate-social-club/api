-- Durable mirror of operator-coordinated refunds for treasury deposits that never
-- entered campaign inventory. Campaign accounting counters must remain untouched.
ALTER TABLE reward_campaign_funding_effects
    ADD COLUMN refund_tx_hash TEXT;

ALTER TABLE reward_campaign_funding_effects
    ADD COLUMN refund_coordinator_ref TEXT;

ALTER TABLE reward_campaign_funding_effects
    ADD COLUMN refund_coordinator_state TEXT;

ALTER TABLE reward_campaign_funding_effects
    ADD COLUMN refund_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (refund_attempt_count >= 0);

ALTER TABLE reward_campaign_funding_effects
    ADD COLUMN refund_last_error TEXT;

ALTER TABLE reward_campaign_funding_effects
    ADD COLUMN refund_confirmed_at TIMESTAMPTZ;

ALTER TABLE reward_campaign_funding_effects
    ADD CONSTRAINT reward_campaign_funding_effects_refund_tx_state_check
    CHECK (refund_tx_hash IS NULL OR status IN ('refund_pending', 'refunded'));

ALTER TABLE reward_campaign_funding_effects
    ADD CONSTRAINT reward_campaign_funding_effects_refund_confirmed_state_check
    CHECK (refund_confirmed_at IS NULL OR status = 'refunded');

CREATE UNIQUE INDEX reward_campaign_funding_effects_refund_tx_unique
    ON reward_campaign_funding_effects (chain_id, refund_tx_hash)
    WHERE refund_tx_hash IS NOT NULL;

-- `refunded` now has two meanings: a future refund of inventory that was funded,
-- and a custody refund that never entered campaign inventory. Custody failures
-- retain failure_reason, so they must not alter either campaign counter.
DROP VIEW reward_campaign_accounting_reconciliation;

CREATE VIEW reward_campaign_accounting_reconciliation AS
SELECT
    c.reward_campaign_id,
    c.funded_cents AS stored_funded_cents,
    COALESCE(f.confirmed_cents, 0) AS computed_funded_cents,
    c.reserved_cents AS stored_reserved_cents,
    COALESCE(r.reserved_cents, 0) AS computed_reserved_cents,
    c.credited_cents AS stored_credited_cents,
    COALESCE(r.credited_cents, 0) AS computed_credited_cents,
    c.refunded_cents AS stored_refunded_cents,
    COALESCE(f.refunded_cents, 0) AS computed_refunded_cents,
    (
        c.funded_cents = COALESCE(f.confirmed_cents, 0)
        AND c.reserved_cents = COALESCE(r.reserved_cents, 0)
        AND c.credited_cents = COALESCE(r.credited_cents, 0)
        AND c.refunded_cents = COALESCE(f.refunded_cents, 0)
    ) AS counters_match
FROM reward_campaigns c
LEFT JOIN (
    SELECT
        reward_campaign_id,
        SUM(CASE
            WHEN status = 'confirmed' OR (status = 'refunded' AND failure_reason IS NULL)
            THEN expected_amount_cents ELSE 0 END) AS confirmed_cents,
        SUM(CASE WHEN status = 'refunded' AND failure_reason IS NULL THEN expected_amount_cents ELSE 0 END) AS refunded_cents
    FROM reward_campaign_funding_effects
    GROUP BY reward_campaign_id
) f ON f.reward_campaign_id = c.reward_campaign_id
LEFT JOIN (
    SELECT
        reward_campaign_id,
        SUM(CASE WHEN status = 'reserved' THEN amount_cents ELSE 0 END) AS reserved_cents,
        SUM(CASE WHEN status = 'credited' THEN amount_cents ELSE 0 END) AS credited_cents
    FROM reward_campaign_reservations
    GROUP BY reward_campaign_id
) r ON r.reward_campaign_id = c.reward_campaign_id;
