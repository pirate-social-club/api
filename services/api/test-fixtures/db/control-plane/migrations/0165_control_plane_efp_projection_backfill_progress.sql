-- Durable, observable progress for initial/rebuild EFP projection application.
-- Raw ingestion and serving watermarks remain separate: a chain becomes
-- authoritative only after every snapshotted follower has been committed.

CREATE TABLE efp_follow_projection_backfills (
    chain_id BIGINT PRIMARY KEY CHECK (chain_id > 0),
    target_block BIGINT NOT NULL CHECK (target_block >= 0),
    target_block_hash TEXT NOT NULL,
    projection_revision BIGINT NOT NULL CHECK (projection_revision >= 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'failed', 'complete')),
    total_followers BIGINT NOT NULL CHECK (total_followers >= 0),
    processed_followers BIGINT NOT NULL DEFAULT 0
        CHECK (processed_followers >= 0 AND processed_followers <= total_followers),
    last_error TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CONSTRAINT efp_projection_backfill_failure_valid CHECK (
        (status = 'failed' AND last_error IS NOT NULL)
        OR (status <> 'failed' AND last_error IS NULL)
    ),
    CONSTRAINT efp_projection_backfill_completion_valid CHECK (
        (status = 'complete' AND completed_at IS NOT NULL)
        OR (status <> 'complete' AND completed_at IS NULL)
    )
);

CREATE TABLE efp_follow_projection_backfill_followers (
    chain_id BIGINT NOT NULL,
    target_block BIGINT NOT NULL CHECK (target_block >= 0),
    follower_address TEXT NOT NULL CHECK (follower_address = lower(follower_address)),
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (chain_id, target_block, follower_address),
    FOREIGN KEY (chain_id)
        REFERENCES efp_follow_projection_backfills(chain_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_efp_projection_backfill_followers_pending
    ON efp_follow_projection_backfill_followers(
        chain_id,
        target_block,
        follower_address
    )
    WHERE processed_at IS NULL;
