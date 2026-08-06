-- Correct the original role attribution from a nonexistent personal name to
-- the actual authorizing principal. Preserve the original migration and make
-- the correction explicit in the migration ledger.
UPDATE reward_funding_asset_retirements
SET authorized_by = 'workspace_owner',
    authorization_reference = 'web-release-run:30581575428;owner-chat-authorization:2026-08-06',
    authorized_at = '2026-08-06T00:00:00.000Z'
WHERE reward_funding_asset_retirement_id = 'rfr_base_sepolia_rewards_20260730'
  AND authorized_by = 'alex';

-- Retirement declarations and the evidence produced from them are audit
-- records. Corrections require a new migration; ordinary UPDATE/DELETE is
-- rejected so attribution and cancellation evidence cannot silently drift.
CREATE OR REPLACE FUNCTION reject_reward_funding_retirement_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'reward funding retirement audit records are immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER reward_funding_asset_retirements_immutable
BEFORE UPDATE OR DELETE ON reward_funding_asset_retirements
FOR EACH ROW EXECUTE FUNCTION reject_reward_funding_retirement_audit_mutation();

CREATE TRIGGER reward_retired_funding_cancellations_immutable
BEFORE UPDATE OR DELETE ON reward_retired_funding_cancellations
FOR EACH ROW EXECUTE FUNCTION reject_reward_funding_retirement_audit_mutation();

CREATE TRIGGER reward_funding_retirement_anomalies_immutable
BEFORE UPDATE OR DELETE ON reward_funding_retirement_anomalies
FOR EACH ROW EXECUTE FUNCTION reject_reward_funding_retirement_audit_mutation();
