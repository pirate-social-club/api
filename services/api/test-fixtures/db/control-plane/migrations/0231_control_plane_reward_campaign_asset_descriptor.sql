-- Campaign-level settlement-asset descriptor, snapshotted at creation.
--
-- Until now the asset a campaign settles in was resolved from deployment
-- configuration at funding time, so an environment token/chain change silently
-- re-denominated every historical campaign. Snapshotting the descriptor on the
-- campaign row makes the asset part of the campaign's immutable terms, the same
-- way booking_payment_intents freezes chain/token/decimals/symbol at quote time.
--
-- All four columns are set together at creation. Rows created before this
-- migration keep NULLs, meaning "legacy: asset was the deployment-configured
-- settlement asset at the time"; a NULL descriptor is set-once so a later
-- backfill remains possible, but a populated descriptor can never change.
-- Addresses are stored lowercase, matching observed_funding_receipts (0143)
-- and reward_funding_asset_retirements (0195).

-- Statements are kept one clause each so the SQLite test mirror can apply the
-- column additions verbatim; the table-level completeness constraint below is
-- PostgreSQL-only, matching how other ADD CONSTRAINT migrations mirror.

ALTER TABLE reward_campaigns
    ADD COLUMN asset_chain_id INTEGER
        CHECK (asset_chain_id IS NULL OR asset_chain_id > 0);

ALTER TABLE reward_campaigns
    ADD COLUMN asset_token_address TEXT
        CHECK (asset_token_address IS NULL OR asset_token_address ~ '^0x[0-9a-f]{40}$');

ALTER TABLE reward_campaigns
    ADD COLUMN asset_token_decimals INTEGER
        CHECK (
            asset_token_decimals IS NULL
            OR (asset_token_decimals >= 0 AND asset_token_decimals <= 36)
        );

ALTER TABLE reward_campaigns
    ADD COLUMN asset_token_symbol TEXT
        CHECK (
            asset_token_symbol IS NULL
            OR (length(asset_token_symbol) >= 1 AND length(asset_token_symbol) <= 20)
        );

-- migration-safety: existing-table-check-reviewed: the constraint references only the four columns added above, and existing rows hold NULL in all four, so every (IS NULL) = (IS NULL) pair is true.
ALTER TABLE reward_campaigns
    ADD CONSTRAINT reward_campaigns_asset_descriptor_complete_check CHECK (
        (asset_chain_id IS NULL) = (asset_token_address IS NULL)
        AND (asset_chain_id IS NULL) = (asset_token_decimals IS NULL)
        AND (asset_chain_id IS NULL) = (asset_token_symbol IS NULL)
    );

-- Extend the terms-immutability trigger (latest body: 0192) with set-once
-- semantics for the descriptor: NULL -> value is allowed (backfill), any
-- change of a populated descriptor is rejected.
CREATE OR REPLACE FUNCTION reject_reward_campaign_term_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    schedule_changed BOOLEAN :=
        NEW.starts_at IS DISTINCT FROM OLD.starts_at
        OR NEW.ends_at IS DISTINCT FROM OLD.ends_at;
    valid_activation_reanchor BOOLEAN :=
        schedule_changed
        AND (NEW.ends_at - NEW.starts_at) = (OLD.ends_at - OLD.starts_at)
        AND NEW.starts_at >= OLD.starts_at
        AND OLD.status IN ('funding_quoted', 'funding_confirming')
        AND NEW.status IN ('active', 'scheduled');
    budget_changed BOOLEAN := NEW.budget_cents IS DISTINCT FROM OLD.budget_cents;
    valid_confirmed_topup_growth BOOLEAN :=
        budget_changed
        AND OLD.status = 'funding_confirming'
        AND NEW.status IN ('active', 'scheduled', 'paused', 'exhausted', 'ended')
        AND NEW.funded_cents > OLD.funded_cents
        AND NEW.budget_cents >= OLD.budget_cents
        AND NEW.budget_cents = GREATEST(OLD.budget_cents, NEW.funded_cents);
BEGIN
    IF NEW.campaign_kind IS DISTINCT FROM OLD.campaign_kind
        OR NEW.rewarder_user_id IS DISTINCT FROM OLD.rewarder_user_id
        OR NEW.creation_idempotency_key IS DISTINCT FROM OLD.creation_idempotency_key
        OR NEW.community_id IS DISTINCT FROM OLD.community_id
        OR NEW.post_id IS DISTINCT FROM OLD.post_id
        OR NEW.song_artifact_bundle_id IS DISTINCT FROM OLD.song_artifact_bundle_id
        OR NEW.song_owner_user_id IS DISTINCT FROM OLD.song_owner_user_id
        OR NEW.eligible_activity IS DISTINCT FROM OLD.eligible_activity
        OR NEW.daily_reward_cents IS DISTINCT FROM OLD.daily_reward_cents
        OR NEW.milestone_7_cents IS DISTINCT FROM OLD.milestone_7_cents
        OR NEW.milestone_30_cents IS DISTINCT FROM OLD.milestone_30_cents
        OR NEW.reward_period_cap_cents IS DISTINCT FROM OLD.reward_period_cap_cents
        OR (budget_changed AND NOT valid_confirmed_topup_growth)
        OR NEW.platform_fee_bps IS DISTINCT FROM OLD.platform_fee_bps
        OR NEW.platform_fee_cents IS DISTINCT FROM OLD.platform_fee_cents
        OR NEW.terms_version IS DISTINCT FROM OLD.terms_version
        OR NEW.terms_hash IS DISTINCT FROM OLD.terms_hash
        OR NEW.requested_starts_at IS DISTINCT FROM OLD.requested_starts_at
        OR NEW.requested_ends_at IS DISTINCT FROM OLD.requested_ends_at
        OR (schedule_changed AND NOT valid_activation_reanchor)
        OR (OLD.asset_chain_id IS NOT NULL
            AND NEW.asset_chain_id IS DISTINCT FROM OLD.asset_chain_id)
        OR (OLD.asset_token_address IS NOT NULL
            AND NEW.asset_token_address IS DISTINCT FROM OLD.asset_token_address)
        OR (OLD.asset_token_decimals IS NOT NULL
            AND NEW.asset_token_decimals IS DISTINCT FROM OLD.asset_token_decimals)
        OR (OLD.asset_token_symbol IS NOT NULL
            AND NEW.asset_token_symbol IS DISTINCT FROM OLD.asset_token_symbol)
    THEN
        RAISE EXCEPTION 'reward campaign terms are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
