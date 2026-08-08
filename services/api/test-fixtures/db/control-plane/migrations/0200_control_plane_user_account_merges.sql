-- Durable, resumable consolidation of an auto-provisioned integration account
-- into an authenticated canonical account. The source user remains as a foreign-
-- key-safe tombstone; financial ledger rows are never rewritten.

CREATE TABLE user_account_merges (
    user_account_merge_id TEXT PRIMARY KEY,
    source_user_id TEXT NOT NULL REFERENCES users(user_id),
    canonical_user_id TEXT NOT NULL REFERENCES users(user_id),
    link_intent_id TEXT NOT NULL REFERENCES telegram_account_link_intents(link_intent_id),
    status TEXT NOT NULL CHECK (
        status IN ('migrating', 'finalizing', 'completed', 'blocked')
    ),
    block_reason TEXT CHECK (
        block_reason IS NULL OR block_reason IN (
            'distinct_verified_humans',
            'community_authority',
            'authored_content',
            'purchase_activity',
            'booking_activity',
            'cashout_in_flight'
        )
    ),
    block_detail_json JSONB,
    last_error_code TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT user_account_merges_distinct_users_check
        CHECK (source_user_id <> canonical_user_id),
    CONSTRAINT user_account_merges_block_reason_check
        CHECK ((status = 'blocked') = (block_reason IS NOT NULL)),
    CONSTRAINT user_account_merges_completed_at_check
        CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX idx_user_account_merges_source
    ON user_account_merges(source_user_id);

CREATE UNIQUE INDEX idx_user_account_merges_link_intent
    ON user_account_merges(link_intent_id);

CREATE INDEX idx_user_account_merges_resume
    ON user_account_merges(status, updated_at)
    WHERE status IN ('migrating', 'finalizing');

-- Active aliases are installed only after every shard migration succeeds. Reads
-- may then attribute immutable source-owned records to the canonical account.
CREATE TABLE user_account_aliases (
    source_user_id TEXT PRIMARY KEY REFERENCES users(user_id),
    canonical_user_id TEXT NOT NULL REFERENCES users(user_id),
    user_account_merge_id TEXT NOT NULL UNIQUE
        REFERENCES user_account_merges(user_account_merge_id),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    activated_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT user_account_aliases_distinct_users_check
        CHECK (source_user_id <> canonical_user_id),
    CONSTRAINT user_account_aliases_status_timestamps_check CHECK (
        (status = 'active' AND revoked_at IS NULL)
        OR (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

CREATE INDEX idx_user_account_aliases_canonical_active
    ON user_account_aliases(canonical_user_id)
    WHERE status = 'active';

-- Append-only attribution for reward ownership. reward_events and payout ledger
-- rows retain their original user_id; balance/cashout reads follow this record.
CREATE TABLE reward_ownership_transfers (
    reward_ownership_transfer_id TEXT PRIMARY KEY,
    user_account_merge_id TEXT NOT NULL UNIQUE
        REFERENCES user_account_merges(user_account_merge_id),
    source_user_id TEXT NOT NULL REFERENCES users(user_id),
    canonical_user_id TEXT NOT NULL REFERENCES users(user_id),
    effective_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT reward_ownership_transfers_distinct_users_check
        CHECK (source_user_id <> canonical_user_id)
);

CREATE INDEX idx_reward_ownership_transfers_canonical
    ON reward_ownership_transfers(canonical_user_id, effective_at);

-- Records per-community progress so a failed fleet pass resumes without repeating
-- already completed shard work or claiming success after a skipped shard.
CREATE TABLE user_account_merge_shards (
    user_account_merge_id TEXT NOT NULL
        REFERENCES user_account_merges(user_account_merge_id) ON DELETE CASCADE,
    community_id TEXT NOT NULL REFERENCES communities(community_id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code TEXT,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_account_merge_id, community_id),
    CONSTRAINT user_account_merge_shards_completed_at_check
        CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX idx_user_account_merge_shards_resume
    ON user_account_merge_shards(user_account_merge_id, status, updated_at);
