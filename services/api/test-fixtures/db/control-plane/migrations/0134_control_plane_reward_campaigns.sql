-- Budget-backed song-practice reward campaigns.
--
-- A campaign's remaining allocatable budget is:
--   funded_cents - reserved_cents - credited_cents - refunded_cents
-- paid_cents is a settlement projection of credited liabilities and therefore is
-- bounded by credited_cents but is not subtracted a second time.

CREATE TABLE reward_campaigns (
    reward_campaign_id TEXT PRIMARY KEY,
    campaign_kind TEXT NOT NULL DEFAULT 'song_practice'
        CHECK (campaign_kind = 'song_practice'),
    rewarder_user_id TEXT NOT NULL,
    creation_idempotency_key TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT NOT NULL,
    song_owner_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'draft',
        'funding_quoted',
        'funding_confirming',
        'scheduled',
        'active',
        'paused',
        'exhausted',
        'ended',
        'canceled'
    )),
    eligible_activity TEXT NOT NULL DEFAULT 'either'
        CHECK (eligible_activity IN ('study', 'karaoke', 'either')),
    daily_reward_cents INTEGER NOT NULL CHECK (daily_reward_cents > 0),
    milestone_7_cents INTEGER NOT NULL DEFAULT 0 CHECK (milestone_7_cents >= 0),
    milestone_30_cents INTEGER NOT NULL DEFAULT 0 CHECK (milestone_30_cents >= 0),
    reward_period_cap_cents INTEGER NOT NULL CHECK (
        reward_period_cap_cents >= daily_reward_cents + milestone_7_cents
        AND reward_period_cap_cents >= daily_reward_cents + milestone_30_cents
    ),
    budget_cents INTEGER NOT NULL CHECK (budget_cents > 0),
    funded_cents INTEGER NOT NULL DEFAULT 0 CHECK (funded_cents >= 0),
    reserved_cents INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
    credited_cents INTEGER NOT NULL DEFAULT 0 CHECK (credited_cents >= 0),
    paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
    refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
    platform_fee_bps INTEGER NOT NULL DEFAULT 0
        CHECK (platform_fee_bps >= 0 AND platform_fee_bps <= 10000),
    platform_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
    terms_version INTEGER NOT NULL DEFAULT 1 CHECK (terms_version > 0),
    terms_hash TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    activated_at TIMESTAMPTZ,
    exhausted_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (rewarder_user_id) REFERENCES users(user_id),
    FOREIGN KEY (song_owner_user_id) REFERENCES users(user_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    UNIQUE (rewarder_user_id, creation_idempotency_key),
    CHECK (ends_at > starts_at),
    CHECK (funded_cents <= budget_cents),
    CHECK (reserved_cents + credited_cents + refunded_cents <= funded_cents),
    CHECK (paid_cents <= credited_cents),
    CHECK (platform_fee_cents <= funded_cents)
);

CREATE UNIQUE INDEX reward_campaigns_one_live_per_song_post
    ON reward_campaigns (community_id, post_id)
    WHERE status IN ('scheduled', 'active', 'paused');

CREATE INDEX reward_campaigns_rewarder_created_idx
    ON reward_campaigns (rewarder_user_id, created_at DESC);

CREATE INDEX reward_campaigns_target_status_idx
    ON reward_campaigns (community_id, post_id, status);

CREATE INDEX reward_campaigns_reconcile_idx
    ON reward_campaigns (status, starts_at, ends_at, reward_campaign_id);

CREATE TABLE reward_campaign_funding_effects (
    reward_campaign_funding_effect_id TEXT PRIMARY KEY,
    reward_campaign_id TEXT NOT NULL,
    funder_user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    token_address TEXT NOT NULL,
    expected_amount_cents INTEGER NOT NULL CHECK (expected_amount_cents > 0),
    expected_amount_atomic TEXT NOT NULL,
    received_amount_atomic TEXT,
    sender_address TEXT NOT NULL,
    treasury_address TEXT NOT NULL,
    tx_hash TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'quoted', 'confirming', 'confirmed', 'failed', 'refunded'
    )),
    failure_reason TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    confirmed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    refunded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (reward_campaign_id) REFERENCES reward_campaigns(reward_campaign_id),
    FOREIGN KEY (funder_user_id) REFERENCES users(user_id),
    UNIQUE (funder_user_id, idempotency_key),
    CHECK (received_amount_atomic IS NULL OR status IN ('confirmed', 'refunded')),
    CHECK (confirmed_at IS NULL OR status IN ('confirmed', 'refunded')),
    CHECK (refunded_at IS NULL OR status = 'refunded')
);

-- A transaction hash may be claimed by only one funding effect, including while
-- confirmation is in progress. Pending receipts remain confirming rather than
-- failed so a later retry can safely resume the same effect.
CREATE UNIQUE INDEX reward_campaign_funding_effects_tx_unique
    ON reward_campaign_funding_effects (chain_id, tx_hash)
    WHERE tx_hash IS NOT NULL;

CREATE INDEX reward_campaign_funding_effects_campaign_idx
    ON reward_campaign_funding_effects (reward_campaign_id, created_at DESC);

CREATE INDEX reward_campaign_funding_effects_confirming_idx
    ON reward_campaign_funding_effects (status, updated_at, reward_campaign_funding_effect_id)
    WHERE status = 'confirming';

-- Durable, idempotent qualifications consumed from community shard outboxes.
CREATE TABLE reward_qualification_events (
    reward_qualification_event_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    shard_sequence INTEGER NOT NULL CHECK (shard_sequence > 0),
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT NOT NULL,
    activity TEXT NOT NULL CHECK (activity IN ('study', 'karaoke')),
    qualified_at TIMESTAMPTZ NOT NULL,
    reward_period_key DATE NOT NULL,
    qualification_policy_version TEXT NOT NULL,
    evidence_summary_json JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    UNIQUE (community_id, shard_sequence)
);

CREATE INDEX reward_qualification_events_target_period_idx
    ON reward_qualification_events (
        community_id, post_id, reward_period_key, reward_qualification_event_id
    );

CREATE TABLE reward_qualification_checkpoints (
    community_id TEXT PRIMARY KEY,
    last_shard_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_shard_sequence >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

-- A reservation is the exact liability created before the product says a reward
-- was earned. reward_identity_id is the durable cap/dedup key; user_id remains the
-- account that receives the eventual ledger credit.
CREATE TABLE reward_campaign_reservations (
    reward_campaign_reservation_id TEXT PRIMARY KEY,
    reward_campaign_id TEXT NOT NULL,
    reward_identity_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    reward_period_key DATE NOT NULL,
    reward_kind TEXT NOT NULL CHECK (reward_kind IN (
        'campaign_practice_day',
        'campaign_milestone_7',
        'campaign_milestone_30'
    )),
    qualification_basis TEXT NOT NULL CHECK (
        qualification_basis IN ('study', 'karaoke', 'both')
    ),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'credited', 'released')),
    reward_event_id TEXT,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    credited_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    release_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (reward_campaign_id) REFERENCES reward_campaigns(reward_campaign_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (reward_event_id) REFERENCES reward_events(reward_event_id),
    UNIQUE (reward_campaign_id, reward_identity_id, reward_period_key, reward_kind),
    CHECK (reward_event_id IS NULL OR status = 'credited'),
    CHECK (credited_at IS NULL OR status = 'credited'),
    CHECK (released_at IS NULL OR status = 'released')
);

CREATE INDEX reward_campaign_reservations_user_period_idx
    ON reward_campaign_reservations (reward_identity_id, reward_period_key, status);

CREATE INDEX reward_campaign_reservations_campaign_status_idx
    ON reward_campaign_reservations (reward_campaign_id, status, reserved_at);

ALTER TABLE reward_events
    ADD COLUMN reward_campaign_id TEXT REFERENCES reward_campaigns(reward_campaign_id);

ALTER TABLE reward_events
    ADD COLUMN reward_campaign_reservation_id TEXT
        REFERENCES reward_campaign_reservations(reward_campaign_reservation_id);

ALTER TABLE reward_events ADD COLUMN reward_identity_id TEXT;

ALTER TABLE reward_events ADD COLUMN reward_period_key DATE;

ALTER TABLE reward_events
    ADD COLUMN qualification_basis TEXT
        CHECK (qualification_basis IS NULL OR qualification_basis IN ('study', 'karaoke', 'both'));

ALTER TABLE reward_events ADD COLUMN campaign_terms_version INTEGER;

ALTER TABLE reward_events ADD COLUMN campaign_rate_snapshot_json JSONB;

ALTER TABLE reward_events DROP CONSTRAINT reward_events_reward_kind_check;
ALTER TABLE reward_events ADD CONSTRAINT reward_events_reward_kind_check CHECK (
    reward_kind IN (
        'study_streak_day',
        'study_streak_milestone_7',
        'study_streak_milestone_30',
        'campaign_practice_day',
        'campaign_milestone_7',
        'campaign_milestone_30'
    )
);

ALTER TABLE reward_events DROP CONSTRAINT reward_events_source_check;
ALTER TABLE reward_events ADD CONSTRAINT reward_events_source_check CHECK (
    source IN ('song_engagement_reconciler', 'reward_campaign_reconciler')
);

CREATE UNIQUE INDEX reward_events_campaign_reservation_unique
    ON reward_events (reward_campaign_reservation_id)
    WHERE reward_campaign_reservation_id IS NOT NULL;

CREATE INDEX reward_events_campaign_created_idx
    ON reward_events (reward_campaign_id, created_at DESC)
    WHERE reward_campaign_id IS NOT NULL;
