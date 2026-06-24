-- Global royalty-allocation discovery index. Allocations live in partitioned
-- community DBs, but a collaborator (e.g. a producer) may receive royalty tokens
-- without ever joining that community. This control-plane projection lets claim
-- discovery find allocations by Pirate user or by wallet, replacing the
-- community-membership scan. See core/specs/domain/royalty-allocation.md.
-- Reflects the INITIAL allocation agreement. Live royalty ownership is read from
-- chain (RTs are transferable).

CREATE TABLE story_royalty_allocation_projections (
    projection_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    story_ip_id TEXT NOT NULL,
    ip_royalty_vault TEXT,
    recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('creator', 'collaborator')),
    recipient_user_id TEXT,
    wallet_attachment_id TEXT,
    wallet_address_normalized TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    initial_share_bps INTEGER NOT NULL CHECK (initial_share_bps > 0 AND initial_share_bps <= 10000),
    allocation_fingerprint TEXT NOT NULL,
    distribution_status TEXT NOT NULL CHECK (
        distribution_status IN ('pending', 'verified', 'failed')
    ),
    -- Asset-level allocation status mirror so ops can distinguish registration
    -- failure from verification failure without opening the community DB.
    allocation_status TEXT NOT NULL DEFAULT 'none' CHECK (
        allocation_status IN (
            'none',
            'draft',
            'registration_pending',
            'verification_pending',
            'verified',
            'registration_failed',
            'verification_failed',
            'legacy_unverified'
        )
    ),
    failure_reason TEXT,
    source_updated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_story_royalty_allocation_projections_unique
    ON story_royalty_allocation_projections(community_id, asset_id, wallet_address_normalized);

CREATE INDEX idx_story_royalty_allocation_projections_user
    ON story_royalty_allocation_projections(recipient_user_id, updated_at)
    WHERE recipient_user_id IS NOT NULL;

CREATE INDEX idx_story_royalty_allocation_projections_wallet
    ON story_royalty_allocation_projections(wallet_address_normalized, updated_at);

CREATE INDEX idx_story_royalty_allocation_projections_ip
    ON story_royalty_allocation_projections(story_ip_id);
