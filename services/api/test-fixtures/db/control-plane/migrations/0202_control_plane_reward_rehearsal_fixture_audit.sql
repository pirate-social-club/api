-- Rehearsal campaigns deliberately exercise settlement without receiving a new
-- on-chain deposit. Record that synthetic funding in a separate immutable
-- ledger so it cannot be confused with custody-proven campaign funding.

CREATE TABLE reward_campaign_fixture_funding_effects (
    reward_campaign_fixture_funding_effect_id TEXT PRIMARY KEY,
    reward_campaign_id TEXT NOT NULL UNIQUE
        REFERENCES reward_campaigns(reward_campaign_id),
    fixture_kind TEXT NOT NULL CHECK (
        fixture_kind = 'rewards_vault_rehearsal_baseline'
    ),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    recorded_by TEXT NOT NULL CHECK (length(trim(recorded_by)) > 0),
    recorded_at TIMESTAMPTZ NOT NULL,
    evidence_json JSONB NOT NULL
);

CREATE INDEX reward_campaign_fixture_funding_effects_recorded_idx
    ON reward_campaign_fixture_funding_effects(recorded_at, reward_campaign_id);

-- Archival does not delete campaigns, reservations, events, payouts, or
-- incidents. It is an immutable operator decision describing why an ended
-- staging-only fixture was retired from further rehearsal use.
CREATE TABLE reward_campaign_fixture_archives (
    reward_campaign_id TEXT PRIMARY KEY
        REFERENCES reward_campaigns(reward_campaign_id),
    archive_reason TEXT NOT NULL CHECK (
        archive_reason = 'fixture_without_funding_provenance'
    ),
    archived_by TEXT NOT NULL CHECK (length(trim(archived_by)) > 0),
    archived_at TIMESTAMPTZ NOT NULL,
    evidence_json JSONB NOT NULL
);

CREATE INDEX reward_campaign_fixture_archives_recorded_idx
    ON reward_campaign_fixture_archives(archived_at, reward_campaign_id);

-- Keep synthetic rehearsal funding distinct in storage while allowing the
-- accounting reconciliation to prove that every stored funded cent has one
-- explicit source. Finality monitoring continues to scan only the real
-- reward_campaign_funding_effects table.
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
        sources.reward_campaign_id,
        SUM(sources.confirmed_cents) AS confirmed_cents,
        SUM(sources.refunded_cents) AS refunded_cents
    FROM (
        SELECT
            reward_campaign_id,
            SUM(CASE
                WHEN status = 'confirmed' OR (status = 'refunded' AND failure_reason IS NULL)
                THEN expected_amount_cents ELSE 0 END) AS confirmed_cents,
            SUM(CASE
                WHEN status = 'refunded' AND failure_reason IS NULL
                THEN expected_amount_cents ELSE 0 END) AS refunded_cents
        FROM reward_campaign_funding_effects
        GROUP BY reward_campaign_id

        UNION ALL

        SELECT reward_campaign_id, amount_cents AS confirmed_cents, 0 AS refunded_cents
        FROM reward_campaign_fixture_funding_effects
    ) sources
    GROUP BY sources.reward_campaign_id
) f ON f.reward_campaign_id = c.reward_campaign_id
LEFT JOIN (
    SELECT
        reward_campaign_id,
        SUM(CASE WHEN status = 'reserved' THEN amount_cents ELSE 0 END) AS reserved_cents,
        SUM(CASE WHEN status = 'credited' THEN amount_cents ELSE 0 END) AS credited_cents
    FROM reward_campaign_reservations
    GROUP BY reward_campaign_id
) r ON r.reward_campaign_id = c.reward_campaign_id;

CREATE OR REPLACE FUNCTION reject_reward_campaign_fixture_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'reward campaign fixture audit records are immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER reward_campaign_fixture_funding_effects_immutable
BEFORE UPDATE OR DELETE ON reward_campaign_fixture_funding_effects
FOR EACH ROW EXECUTE FUNCTION reject_reward_campaign_fixture_audit_mutation();

CREATE TRIGGER reward_campaign_fixture_archives_immutable
BEFORE UPDATE OR DELETE ON reward_campaign_fixture_archives
FOR EACH ROW EXECUTE FUNCTION reject_reward_campaign_fixture_audit_mutation();
