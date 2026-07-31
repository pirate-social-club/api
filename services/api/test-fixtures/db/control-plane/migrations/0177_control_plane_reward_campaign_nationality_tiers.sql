-- Persist immutable nationality payout terms without enabling tiered funding or
-- claim-time resolution. Existing campaigns are backfilled as uniform terms.

ALTER TABLE reward_campaigns
    ADD COLUMN default_amount_cents INTEGER;

ALTER TABLE reward_campaigns
    ADD COLUMN max_claim_cents INTEGER;

ALTER TABLE reward_campaigns
    ADD COLUMN payout_tiers_json JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE reward_campaigns
SET default_amount_cents = daily_reward_cents,
    max_claim_cents = daily_reward_cents
WHERE default_amount_cents IS NULL OR max_claim_cents IS NULL;

ALTER TABLE reward_campaigns
    ALTER COLUMN default_amount_cents SET NOT NULL,
    ALTER COLUMN max_claim_cents SET NOT NULL,
    ADD CONSTRAINT reward_campaign_default_amount_positive_check
        CHECK (default_amount_cents > 0),
    ADD CONSTRAINT reward_campaign_max_claim_bounds_check
        CHECK (max_claim_cents >= default_amount_cents),
    ADD CONSTRAINT reward_campaign_payout_tiers_shape_check
        CHECK (
            jsonb_typeof(payout_tiers_json) = 'array'
            AND jsonb_array_length(payout_tiers_json) <= 10
        );

-- The original immutability trigger predates these columns. Keep the extension
-- separate so older migration history remains reproducible.
CREATE FUNCTION reject_reward_campaign_payout_term_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.default_amount_cents IS DISTINCT FROM OLD.default_amount_cents
        OR NEW.max_claim_cents IS DISTINCT FROM OLD.max_claim_cents
        OR NEW.payout_tiers_json IS DISTINCT FROM OLD.payout_tiers_json
    THEN
        RAISE EXCEPTION 'reward campaign payout terms are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER reward_campaigns_payout_terms_immutable
BEFORE UPDATE ON reward_campaigns
FOR EACH ROW
EXECUTE FUNCTION reject_reward_campaign_payout_term_changes();
