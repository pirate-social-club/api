-- Harden the EFP projection before it contains production data.
--
-- This projection is intentionally follows-only. EFP block and mute tags are
-- inputs to effective-follow derivation, but are not themselves projected.
-- A future Pirate block/mute product requires a separate projection rather
-- than overloading the (follower, followed) edge identity below.

ALTER TABLE efp_effective_follows
    ADD CONSTRAINT efp_effective_follows_follower_lowercase
        CHECK (follower_address = lower(follower_address)),
    ADD CONSTRAINT efp_effective_follows_followed_lowercase
        CHECK (followed_address = lower(followed_address)),
    ADD CONSTRAINT efp_effective_follows_contract_lowercase
        CHECK (list_contract_address = lower(list_contract_address));

ALTER TABLE efp_follow_counts
    ADD CONSTRAINT efp_follow_counts_wallet_lowercase
        CHECK (wallet_address = lower(wallet_address));

-- Projection health is meaningful only relative to an explicit coverage set.
-- The materializer may set status='current' only when every enabled chain has
-- a projection watermark within that chain's confirmation buffer.
CREATE TABLE efp_follow_projection_expected_chains (
    chain_id BIGINT PRIMARY KEY CHECK (chain_id > 0),
    confirmation_buffer_blocks BIGINT NOT NULL
        CHECK (confirmation_buffer_blocks >= 0),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL
);

INSERT INTO efp_follow_projection_expected_chains (
    chain_id,
    confirmation_buffer_blocks,
    enabled,
    updated_at
) VALUES
    (1, 64, TRUE, CURRENT_TIMESTAMP),
    (10, 64, TRUE, CURRENT_TIMESTAMP),
    (8453, 64, TRUE, CURRENT_TIMESTAMP);

-- Records the latest counter/edge invariant check. A failed check makes graph
-- health observable and prevents serving drift as a current projection.
ALTER TABLE efp_follow_projection_state
    ADD COLUMN last_reconciled_at TIMESTAMPTZ,
    ADD COLUMN last_reconciliation_error TEXT;
