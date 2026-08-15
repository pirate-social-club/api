-- Reward-ticket claim receipts are net of winnings referral share. Preserve
-- gross payout evidence and fail closed unless gross, custody receipt, and the
-- separate platform referral accrual conserve exactly.

ALTER TABLE reward_ticket_claim_effects
    ADD COLUMN gross_tier_payout_atomic NUMERIC(78, 0)
        CHECK (gross_tier_payout_atomic IS NULL OR gross_tier_payout_atomic > 0),
    ADD COLUMN referral_accrual_atomic NUMERIC(78, 0)
        CHECK (referral_accrual_atomic IS NULL OR referral_accrual_atomic >= 0);

UPDATE reward_ticket_claim_effects
SET gross_tier_payout_atomic = received_amount_atomic,
    referral_accrual_atomic = 0
WHERE status = 'confirmed';

ALTER TABLE reward_ticket_claim_effects
    DROP CONSTRAINT reward_ticket_claim_effects_finalized_shape_check,
    ADD CONSTRAINT reward_ticket_claim_effects_finalized_shape_check CHECK (
        (status = 'confirmed' AND finalized_at IS NOT NULL
            AND gross_tier_payout_atomic IS NOT NULL
            AND referral_accrual_atomic IS NOT NULL
            AND protocol_reported_winnings_atomic = received_amount_atomic
            AND gross_tier_payout_atomic = received_amount_atomic + referral_accrual_atomic)
        OR (status <> 'confirmed' AND finalized_at IS NULL)
    );

CREATE OR REPLACE FUNCTION enforce_reward_ticket_platform_revenue_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    source_chain_id INTEGER;
    source_token_address TEXT;
    source_tx_hash TEXT;
    source_status TEXT;
    source_finalized_at TIMESTAMPTZ;
    source_referral_accrual_atomic NUMERIC(78, 0);
BEGIN
    IF EXISTS (
        SELECT 1 FROM reward_ticket_custody_backing_domains AS domain
        WHERE domain.chain_id = NEW.chain_id
          AND LOWER(domain.token_address) = LOWER(NEW.token_address)
          AND LOWER(domain.custody_address) = LOWER(NEW.platform_revenue_address)
    ) THEN
        RAISE EXCEPTION 'platform referral revenue address must be outside beneficiary custody'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.entry_kind = 'purchase_referral_accrual' THEN
        SELECT pool.chain_id, pool.usdc_token_address, effect.tx_hash,
               effect.status, effect.finalized_at
        INTO source_chain_id, source_token_address, source_tx_hash,
             source_status, source_finalized_at
        FROM reward_ticket_purchase_effects AS effect
        JOIN reward_ticket_pool_drawings AS drawing
          ON drawing.reward_ticket_pool_drawing_id = effect.reward_ticket_pool_drawing_id
        JOIN reward_ticket_pools AS pool
          ON pool.reward_ticket_pool_id = drawing.reward_ticket_pool_id
        WHERE effect.reward_ticket_purchase_effect_id = NEW.reward_ticket_purchase_effect_id;
    ELSIF NEW.entry_kind = 'winnings_referral_accrual' THEN
        SELECT pool.chain_id, pool.usdc_token_address, effect.tx_hash,
               effect.status, effect.finalized_at, effect.referral_accrual_atomic
        INTO source_chain_id, source_token_address, source_tx_hash,
             source_status, source_finalized_at, source_referral_accrual_atomic
        FROM reward_ticket_claim_effects AS effect
        JOIN reward_ticket_pool_drawings AS drawing
          ON drawing.reward_ticket_pool_drawing_id = effect.reward_ticket_pool_drawing_id
        JOIN reward_ticket_pools AS pool
          ON pool.reward_ticket_pool_id = drawing.reward_ticket_pool_id
        WHERE effect.reward_ticket_claim_effect_id = NEW.reward_ticket_claim_effect_id;
    ELSE
        RETURN NEW;
    END IF;

    IF source_status IS DISTINCT FROM 'confirmed'
       OR source_finalized_at IS NULL
       OR source_chain_id IS DISTINCT FROM NEW.chain_id
       OR LOWER(source_token_address) IS DISTINCT FROM LOWER(NEW.token_address)
       OR LOWER(source_tx_hash) IS DISTINCT FROM LOWER(NEW.tx_hash)
       OR (NEW.entry_kind = 'winnings_referral_accrual'
           AND source_referral_accrual_atomic IS DISTINCT FROM NEW.amount_atomic) THEN
        RAISE EXCEPTION 'platform referral accrual does not match a finalized source receipt'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_reward_ticket_claim_effect_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status <> OLD.status AND NOT (
        (OLD.status = 'detected' AND NEW.status IN ('submitted', 'failed', 'needs_review'))
        OR (OLD.status = 'submitted' AND NEW.status IN ('confirmed', 'failed', 'needs_review'))
        OR (OLD.status = 'needs_review' AND NEW.status IN ('confirmed', 'failed'))
    ) THEN
        RAISE EXCEPTION 'invalid reward ticket claim effect transition: % -> %',
            OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;

    IF OLD.finalized_at IS NOT NULL AND ROW(
        NEW.reward_ticket_pool_drawing_id, NEW.idempotency_key, NEW.tx_hash,
        NEW.protocol_reported_winnings_atomic, NEW.received_amount_atomic,
        NEW.gross_tier_payout_atomic, NEW.referral_accrual_atomic,
        NEW.confirmed_block_number, NEW.confirmed_block_hash,
        NEW.submitted_at, NEW.confirmed_at, NEW.finalized_at
    ) IS DISTINCT FROM ROW(
        OLD.reward_ticket_pool_drawing_id, OLD.idempotency_key, OLD.tx_hash,
        OLD.protocol_reported_winnings_atomic, OLD.received_amount_atomic,
        OLD.gross_tier_payout_atomic, OLD.referral_accrual_atomic,
        OLD.confirmed_block_number, OLD.confirmed_block_hash,
        OLD.submitted_at, OLD.confirmed_at, OLD.finalized_at
    ) THEN
        RAISE EXCEPTION 'finalized reward ticket claim receipt is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

GRANT SELECT, INSERT, UPDATE ON reward_ticket_claim_effects TO control_plane_api_rw;
