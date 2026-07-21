-- Attribute reward cashouts to the credits they settle.
--
-- A reward payout may aggregate credits from more than one campaign (and from
-- legacy, non-campaign rewards), so reward_payout_effects alone cannot safely
-- advance reward_campaigns.paid_cents.  Allocations are created atomically
-- with a submitted payout, then transition with that payout.  This preserves
-- the user-level cashout ledger while providing an exact campaign settlement
-- projection.

CREATE TABLE reward_payout_allocations (
    reward_payout_allocation_id TEXT PRIMARY KEY,
    reward_payout_effect_id TEXT NOT NULL
        REFERENCES reward_payout_effects(reward_payout_effect_id),
    reward_event_id TEXT NOT NULL
        REFERENCES reward_events(reward_event_id),
    reward_campaign_id TEXT
        REFERENCES reward_campaigns(reward_campaign_id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    status TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'released')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (reward_payout_effect_id, reward_event_id),
    CONSTRAINT reward_payout_allocations_confirmed_at_status_check
        CHECK (confirmed_at IS NULL OR status = 'confirmed'),
    CONSTRAINT reward_payout_allocations_released_at_status_check
        CHECK (released_at IS NULL OR status = 'released')
);

CREATE INDEX reward_payout_allocations_effect_status_idx
    ON reward_payout_allocations (reward_payout_effect_id, status);

CREATE INDEX reward_payout_allocations_event_status_idx
    ON reward_payout_allocations (reward_event_id, status);

CREATE INDEX reward_payout_allocations_campaign_status_idx
    ON reward_payout_allocations (reward_campaign_id, status)
    WHERE reward_campaign_id IS NOT NULL;

-- Backfill only unambiguous historical settlement: a user with exactly one
-- confirmed payout and exactly one campaign-backed reward event, of the same
-- amount.  Mixed histories deliberately remain unallocated rather than being
-- guessed; they require an explicit, reviewed reconciliation.
WITH unambiguous AS (
    SELECT
        p.reward_payout_effect_id,
        e.reward_event_id,
        e.reward_campaign_id,
        p.amount_cents
    FROM reward_payout_effects p
    JOIN reward_events e
      ON e.user_id = p.user_id
     AND e.reward_campaign_id IS NOT NULL
     AND e.amount_cents = p.amount_cents
    WHERE p.status = 'confirmed'
      AND NOT EXISTS (
          SELECT 1
          FROM reward_payout_allocations a
          WHERE a.reward_payout_effect_id = p.reward_payout_effect_id
      )
      AND 1 = (
          SELECT COUNT(*)
          FROM reward_payout_effects p2
          WHERE p2.user_id = p.user_id
            AND p2.status = 'confirmed'
      )
      AND 1 = (
          SELECT COUNT(*)
          FROM reward_events e2
          WHERE e2.user_id = p.user_id
            AND e2.reward_campaign_id IS NOT NULL
      )
), inserted AS (
    INSERT INTO reward_payout_allocations (
        reward_payout_allocation_id,
        reward_payout_effect_id,
        reward_event_id,
        reward_campaign_id,
        amount_cents,
        status,
        created_at,
        confirmed_at,
        updated_at
    )
    SELECT
        'rpa_backfill_' || reward_payout_effect_id,
        reward_payout_effect_id,
        reward_event_id,
        reward_campaign_id,
        amount_cents,
        'confirmed',
        NOW(),
        NOW(),
        NOW()
    FROM unambiguous
    ON CONFLICT (reward_payout_effect_id, reward_event_id) DO NOTHING
    RETURNING reward_campaign_id, amount_cents
), totals AS (
    SELECT reward_campaign_id, SUM(amount_cents) AS amount_cents
    FROM inserted
    GROUP BY reward_campaign_id
)
UPDATE reward_campaigns campaign
SET paid_cents = campaign.paid_cents + totals.amount_cents,
    updated_at = NOW()
FROM totals
WHERE campaign.reward_campaign_id = totals.reward_campaign_id;
