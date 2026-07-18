-- A verified treasury deposit that cannot be applied to its campaign must remain
-- durable until the operator-signed refund executor settles it. It is not a
-- generic funding failure: the treasury has custody of the sender's money.
ALTER TABLE reward_campaign_funding_effects
    DROP CONSTRAINT reward_campaign_funding_effects_status_check;

ALTER TABLE reward_campaign_funding_effects
    ADD CONSTRAINT reward_campaign_funding_effects_status_check CHECK (status IN (
        'quoted', 'confirming', 'confirmed', 'failed', 'refund_pending', 'refunded'
    ));

ALTER TABLE reward_campaign_funding_effects
    DROP CONSTRAINT reward_campaign_funding_effects_received_amount_atomic_check;

ALTER TABLE reward_campaign_funding_effects
    ADD CONSTRAINT reward_campaign_funding_effects_received_amount_atomic_check
    CHECK (received_amount_atomic IS NULL OR status IN ('confirmed', 'refund_pending', 'refunded'));

ALTER TABLE reward_campaign_funding_effects
    DROP CONSTRAINT reward_campaign_funding_effects_confirmed_at_check;

ALTER TABLE reward_campaign_funding_effects
    ADD CONSTRAINT reward_campaign_funding_effects_confirmed_at_check
    CHECK (confirmed_at IS NULL OR status IN ('confirmed', 'refund_pending', 'refunded'));

CREATE INDEX reward_campaign_funding_effects_refund_pending_idx
    ON reward_campaign_funding_effects (updated_at, reward_campaign_funding_effect_id)
    WHERE status = 'refund_pending';

-- Keep the creator-approved schedule available for terms-hash/idempotency audits
-- when a narrowly late deposit causes the effective campaign window to be
-- re-anchored at acceptance time.
ALTER TABLE reward_campaigns ADD COLUMN requested_starts_at TIMESTAMPTZ;
ALTER TABLE reward_campaigns ADD COLUMN requested_ends_at TIMESTAMPTZ;

UPDATE reward_campaigns
SET requested_starts_at = starts_at,
    requested_ends_at = ends_at;

ALTER TABLE reward_campaigns ALTER COLUMN requested_starts_at SET NOT NULL;
ALTER TABLE reward_campaigns ALTER COLUMN requested_ends_at SET NOT NULL;
