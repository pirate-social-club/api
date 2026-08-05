-- A confirmed contribution can grow a permanent pool beyond its original
-- budget. Keep the creator's budget immutable everywhere else: growth is
-- allowed only when funded inventory grows in the same funding-confirmation
-- transition, and only to max(previous budget, new funded inventory).
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
    THEN
        RAISE EXCEPTION 'reward campaign terms are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
