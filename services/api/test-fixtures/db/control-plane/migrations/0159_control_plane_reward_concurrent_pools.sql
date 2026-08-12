-- Convert exclusive, budget-capped reward campaigns into stable song pools
-- backed by append-only contribution lots.

-- A permanent pool identity replaces the expiring quote reservation. Historical
-- ended/canceled campaigns remain in reward_campaigns but do not occupy a pool.
CREATE TABLE reward_song_pools (
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    reward_campaign_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, post_id),
    UNIQUE (reward_campaign_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (reward_campaign_id) REFERENCES reward_campaigns(reward_campaign_id)
);

-- Preserve the newest non-terminal campaign as the initial pool identity.
-- ROW_NUMBER plus the explicit ordering makes legacy convergence deterministic
-- and keeps the migration portable to the local SQLite control-plane mirror.
INSERT INTO reward_song_pools (
    community_id, post_id, reward_campaign_id, created_at, updated_at
)
SELECT
    ranked.community_id,
    ranked.post_id,
    ranked.reward_campaign_id,
    ranked.created_at,
    ranked.updated_at
FROM (
    SELECT
        campaign.community_id,
        campaign.post_id,
        campaign.reward_campaign_id,
        campaign.created_at,
        campaign.updated_at,
        ROW_NUMBER() OVER (
            PARTITION BY campaign.community_id, campaign.post_id
            ORDER BY
                CASE campaign.status
                    WHEN 'active' THEN 0
                    WHEN 'operational_hold' THEN 1
                    WHEN 'paused' THEN 2
                    WHEN 'scheduled' THEN 3
                    WHEN 'exhausted' THEN 4
                    WHEN 'funding_confirming' THEN 5
                    WHEN 'funding_quoted' THEN 6
                    WHEN 'draft' THEN 7
                    ELSE 8
                END,
                campaign.updated_at DESC,
                campaign.reward_campaign_id ASC
        ) AS pool_rank
    FROM reward_campaigns AS campaign
    WHERE campaign.status NOT IN ('ended', 'canceled')
) ranked
WHERE pool_rank = 1;

DROP INDEX IF EXISTS reward_campaigns_one_live_per_song_post;
DROP INDEX IF EXISTS reward_campaigns_one_open_per_rewarder_song;
DROP TABLE IF EXISTS reward_song_slots;

-- budget_cents is retained as a backwards-compatible display watermark, not
-- an admission ceiling. The application raises it to at least funded_cents
-- whenever a contribution confirms, preserving the legacy storage check.

-- Funding effects are the append-only contribution lots. These fields pin the
-- exact refund ceiling observed when a lot was admitted. Legacy/local-backend
-- rows remain NULL and are excluded from mainnet bounded-lot assertions.
ALTER TABLE reward_campaign_funding_effects
    ADD COLUMN admitted_refund_policy_version TEXT,
    ADD COLUMN admitted_max_refund_atomic TEXT,
    ADD CONSTRAINT reward_funding_admitted_refund_policy_pair_check
    CHECK (
        (admitted_refund_policy_version IS NULL AND admitted_max_refund_atomic IS NULL)
        OR (
            admitted_refund_policy_version ~ '^[1-9][0-9]*$'
            AND admitted_max_refund_atomic ~ '^[1-9][0-9]*$'
        )
    );

CREATE INDEX reward_song_pools_campaign_idx
    ON reward_song_pools (reward_campaign_id, community_id, post_id);

CREATE INDEX reward_contribution_lots_fifo_idx
    ON reward_campaign_funding_effects (
        reward_campaign_id, confirmed_at, reward_campaign_funding_effect_id
    )
    WHERE status IN ('confirmed', 'refunded');

-- Pin every credited reservation to the confirmed contribution lots it
-- consumed. Allocations are append-only audit evidence; FIFO is enforced by
-- the reconciler while holding the campaign row lock.
CREATE TABLE reward_campaign_reservation_funding_allocations (
    reward_campaign_reservation_id TEXT NOT NULL
        REFERENCES reward_campaign_reservations(reward_campaign_reservation_id),
    reward_campaign_funding_effect_id TEXT NOT NULL
        REFERENCES reward_campaign_funding_effects(reward_campaign_funding_effect_id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    allocated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (
        reward_campaign_reservation_id,
        reward_campaign_funding_effect_id
    )
);

CREATE INDEX reward_reservation_funding_allocations_lot_idx
    ON reward_campaign_reservation_funding_allocations (
        reward_campaign_funding_effect_id,
        reward_campaign_reservation_id
    );
