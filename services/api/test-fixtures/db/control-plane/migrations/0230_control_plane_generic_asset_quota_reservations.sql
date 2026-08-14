-- Physical-byte accounting for generic file and learning-deck publication.
-- The community asset/payload rows remain shard-local; this ledger is the
-- control-plane reservation authority used before provider work begins.
CREATE TABLE generic_asset_quota_reservations (
    reservation_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(community_id),
    user_id TEXT NOT NULL REFERENCES users(user_id),
    asset_id TEXT,
    content_blob_id TEXT,
    reservation_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('reserved', 'reconciled', 'released', 'failed')
    ),
    reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes > 0),
    actual_bytes BIGINT CHECK (actual_bytes IS NULL OR actual_bytes >= 0),
    plaintext_bytes BIGINT NOT NULL DEFAULT 0 CHECK (plaintext_bytes >= 0),
    ciphertext_bytes BIGINT NOT NULL DEFAULT 0 CHECK (ciphertext_bytes >= 0),
    package_bytes BIGINT NOT NULL DEFAULT 0 CHECK (package_bytes >= 0),
    policy_version TEXT NOT NULL,
    failure_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    reconciled_at TIMESTAMPTZ,
    CONSTRAINT generic_asset_quota_reservation_key_check
        UNIQUE (user_id, reservation_key),
    CONSTRAINT generic_asset_quota_reservation_actual_check CHECK (
        status <> 'reconciled' OR actual_bytes IS NOT NULL
    ),
    CONSTRAINT generic_asset_quota_reservation_failure_check CHECK (
        status <> 'failed' OR failure_code IS NOT NULL
    )
);

CREATE INDEX idx_generic_asset_quota_reservations_scope
    ON generic_asset_quota_reservations(user_id, community_id, status, created_at DESC);

CREATE INDEX idx_generic_asset_quota_reservations_blob
    ON generic_asset_quota_reservations(content_blob_id)
    WHERE content_blob_id IS NOT NULL;

CREATE INDEX idx_generic_asset_quota_reservations_asset
    ON generic_asset_quota_reservations(asset_id)
    WHERE asset_id IS NOT NULL;
