-- Incremental EFP read model. These rows are derived projections over the raw
-- event history in the 0155 tables; they are not the canonical follow ledger.

CREATE TABLE efp_effective_follows (
    follower_address TEXT NOT NULL,
    followed_address TEXT NOT NULL,
    list_chain_id BIGINT NOT NULL CHECK (list_chain_id > 0),
    list_contract_address TEXT NOT NULL,
    list_slot TEXT NOT NULL,
    source_block_number BIGINT NOT NULL CHECK (source_block_number >= 0),
    source_transaction_hash TEXT NOT NULL,
    source_transaction_index INTEGER NOT NULL CHECK (source_transaction_index >= 0),
    source_log_index INTEGER NOT NULL CHECK (source_log_index >= 0),
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (follower_address, followed_address)
);

-- Supports incremental replacement when an account changes its primary list,
-- as well as following-list reads without replaying raw operations.
CREATE INDEX idx_efp_effective_follows_list
    ON efp_effective_follows(
        list_chain_id,
        list_contract_address,
        list_slot,
        follower_address
    );

-- Supports follower-list reads and incremental follower-count maintenance.
CREATE INDEX idx_efp_effective_follows_followed
    ON efp_effective_follows(followed_address, follower_address);

-- Counts are maintained in the same transaction as effective-edge mutations.
-- A missing row is trustworthy as zero only while the graph projection state
-- below is current. During initialization, lag, rebuild, or failure it means
-- unknown and API callers must return unavailable rather than zero.
CREATE TABLE efp_follow_counts (
    wallet_address TEXT PRIMARY KEY,
    follower_count BIGINT NOT NULL CHECK (follower_count >= 0),
    following_count BIGINT NOT NULL CHECK (following_count >= 0),
    projection_revision BIGINT NOT NULL CHECK (projection_revision >= 0),
    updated_at TIMESTAMPTZ NOT NULL
);

-- One graph-wide health record makes availability an explicit read-model
-- property. The materializer moves the revision only after atomically applying
-- an incremental batch to both effective edges and counts.
CREATE TABLE efp_follow_projection_state (
    projection_key TEXT PRIMARY KEY CHECK (projection_key = 'effective-graph'),
    status TEXT NOT NULL CHECK (
        status IN ('initializing', 'current', 'stale', 'rebuilding', 'unavailable')
    ),
    projection_revision BIGINT NOT NULL CHECK (projection_revision >= 0),
    last_successful_at TIMESTAMPTZ,
    status_changed_at TIMESTAMPTZ NOT NULL,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT efp_follow_projection_current_state_valid
    CHECK (
        (status = 'current' AND last_successful_at IS NOT NULL AND last_error IS NULL)
        OR status <> 'current'
    )
);

INSERT INTO efp_follow_projection_state (
    projection_key,
    status,
    projection_revision,
    last_successful_at,
    status_changed_at,
    last_error,
    updated_at
) VALUES (
    'effective-graph',
    'initializing',
    0,
    NULL,
    CURRENT_TIMESTAMP,
    NULL,
    CURRENT_TIMESTAMP
);

-- Applied watermarks are separate from ingestion cursors: raw events may be
-- ahead of the materialized graph. Serving code can compare the two and expose
-- precise freshness without treating index lag as a confident empty graph.
CREATE TABLE efp_follow_projection_chain_watermarks (
    chain_id BIGINT PRIMARY KEY CHECK (chain_id > 0),
    applied_through_block BIGINT NOT NULL CHECK (applied_through_block >= 0),
    applied_through_block_hash TEXT NOT NULL,
    projection_revision BIGINT NOT NULL CHECK (projection_revision >= 0),
    last_successful_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
