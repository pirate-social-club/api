-- Safety controls required before reward-campaign creation or accrual is enabled.

CREATE TABLE reward_song_owner_policies (
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    song_owner_user_id TEXT NOT NULL,
    third_party_rewards TEXT NOT NULL DEFAULT 'allowed'
        CHECK (third_party_rewards IN ('allowed', 'blocked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, post_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (song_owner_user_id) REFERENCES users(user_id)
);

-- The first pilot does not charge a platform fee. Keeping this invariant in the
-- database prevents a future reservation path from treating fee cents as reward
-- inventory. A later fee-bearing design must fund fees on top of the reward pool.
ALTER TABLE reward_campaigns
    ADD CONSTRAINT reward_campaigns_pilot_zero_fee_check
    CHECK (platform_fee_bps = 0 AND platform_fee_cents = 0);

-- A rewarder may not accumulate multiple unfinished drafts for the same song.
-- A terminal campaign permits a later campaign with new terms.
CREATE UNIQUE INDEX reward_campaigns_one_open_per_rewarder_song
    ON reward_campaigns (rewarder_user_id, community_id, post_id)
    WHERE status IN ('draft', 'funding_quoted', 'funding_confirming');

CREATE INDEX reward_song_owner_policies_owner_idx
    ON reward_song_owner_policies (song_owner_user_id, updated_at DESC);

CREATE TABLE reward_campaign_creation_rate_limits (
    rewarder_user_id TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (rewarder_user_id, window_start),
    FOREIGN KEY (rewarder_user_id) REFERENCES users(user_id)
);

CREATE INDEX reward_campaign_creation_rate_limits_cleanup_idx
    ON reward_campaign_creation_rate_limits (window_start);

-- Operational invariant view. Reconciliation alerts on any false value; the
-- reservation writer must update the campaign counters in the same transaction.
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
        reward_campaign_id,
        SUM(CASE WHEN status IN ('confirmed', 'refunded') THEN expected_amount_cents ELSE 0 END) AS confirmed_cents,
        SUM(CASE WHEN status = 'refunded' THEN expected_amount_cents ELSE 0 END) AS refunded_cents
    FROM reward_campaign_funding_effects
    GROUP BY reward_campaign_id
) f ON f.reward_campaign_id = c.reward_campaign_id
LEFT JOIN (
    SELECT
        reward_campaign_id,
        SUM(CASE WHEN status = 'reserved' THEN amount_cents ELSE 0 END) AS reserved_cents,
        SUM(CASE WHEN status = 'credited' THEN amount_cents ELSE 0 END) AS credited_cents
    FROM reward_campaign_reservations
    GROUP BY reward_campaign_id
) r ON r.reward_campaign_id = c.reward_campaign_id;
