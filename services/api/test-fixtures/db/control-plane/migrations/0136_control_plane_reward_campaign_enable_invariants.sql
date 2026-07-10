-- Database-level enablement invariants for the first reward-campaign pilot.
-- Milestones are intentionally unsupported until their earning semantics ship.
ALTER TABLE reward_campaigns
    ADD CONSTRAINT reward_campaigns_pilot_milestones_disabled_check
    CHECK (milestone_7_cents = 0 AND milestone_30_cents = 0);

-- Campaign terms are immutable after creation. Lifecycle timestamps, status, and
-- accounting counters remain mutable; every field that determines eligibility,
-- rate, duration, ownership, or maximum liability is frozen.
CREATE FUNCTION reject_reward_campaign_term_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
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
        OR NEW.budget_cents IS DISTINCT FROM OLD.budget_cents
        OR NEW.platform_fee_bps IS DISTINCT FROM OLD.platform_fee_bps
        OR NEW.platform_fee_cents IS DISTINCT FROM OLD.platform_fee_cents
        OR NEW.terms_version IS DISTINCT FROM OLD.terms_version
        OR NEW.terms_hash IS DISTINCT FROM OLD.terms_hash
        OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
        OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    THEN
        RAISE EXCEPTION 'reward campaign terms are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER reward_campaigns_terms_immutable
BEFORE UPDATE ON reward_campaigns
FOR EACH ROW
EXECUTE FUNCTION reject_reward_campaign_term_changes();
