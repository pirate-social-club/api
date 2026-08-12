-- Durable on-chain payout-capacity evidence and per-song fairness cursor.
--
-- Capacity is advisory: the vault remains the enforcing boundary. Consumers
-- must reject missing or stale observations and must still classify an exact
-- EpochLimitExceeded trace as a non-terminal deferral.
CREATE TABLE reward_vault_capacity_observations (
    observation_key TEXT PRIMARY KEY CHECK (observation_key = 'rewards_vault'),
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    vault_address TEXT NOT NULL,
    policy_version BIGINT NOT NULL CHECK (policy_version > 0),
    epoch_duration_seconds BIGINT NOT NULL CHECK (epoch_duration_seconds > 0),
    current_epoch NUMERIC(78, 0) NOT NULL CHECK (current_epoch >= 0),
    payout_epoch_cap_atomic NUMERIC(78, 0) NOT NULL CHECK (payout_epoch_cap_atomic >= 0),
    payout_spent_atomic NUMERIC(78, 0) NOT NULL CHECK (payout_spent_atomic >= 0),
    refund_epoch_cap_atomic NUMERIC(78, 0) NOT NULL CHECK (refund_epoch_cap_atomic >= 0),
    refund_spent_atomic NUMERIC(78, 0) NOT NULL CHECK (refund_spent_atomic >= 0),
    observed_block_number BIGINT NOT NULL CHECK (observed_block_number >= 0),
    observed_block_hash TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT reward_vault_capacity_payout_spent_check
        CHECK (payout_spent_atomic <= payout_epoch_cap_atomic),
    CONSTRAINT reward_vault_capacity_refund_spent_check
        CHECK (refund_spent_atomic <= refund_epoch_cap_atomic)
);

CREATE INDEX reward_vault_capacity_observations_freshness_idx
    ON reward_vault_capacity_observations (observed_at DESC);

-- last_selected_at is advanced only when the scheduler actually attempts the
-- head payout attributed to this song. Failed selection/admission does not
-- consume a turn.
CREATE TABLE reward_payout_song_scheduler_state (
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    last_selected_at TIMESTAMPTZ,
    last_reward_payout_effect_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, post_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (last_reward_payout_effect_id)
        REFERENCES reward_payout_effects(reward_payout_effect_id)
);

CREATE INDEX reward_payout_song_scheduler_rotation_idx
    ON reward_payout_song_scheduler_state (
        last_selected_at ASC,
        community_id ASC,
        post_id ASC
    );
