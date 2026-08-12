-- Content-neutral storage and multipart transport. Domain attachment remains in
-- the owning community shard; these rows describe verified bytes and upload
-- mechanics only. Existing song artifact tables remain authoritative until a
-- separately attested dual-read/backfill phase.

CREATE TABLE content_blobs (
    content_blob_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(community_id),
    uploader_user_id TEXT NOT NULL REFERENCES users(user_id),
    status TEXT NOT NULL CHECK (
        status IN (
            'pending_upload',
            'uploaded',
            'verifying',
            'ready',
            'rejected',
            'failed',
            'cancelled'
        )
    ),
    validation_profile TEXT NOT NULL CHECK (length(trim(validation_profile)) > 0),
    declared_filename TEXT,
    declared_mime_type TEXT NOT NULL CHECK (length(trim(declared_mime_type)) > 0),
    declared_size_bytes BIGINT CHECK (
        declared_size_bytes IS NULL OR declared_size_bytes > 0
    ),
    declared_content_hash TEXT,
    detected_mime_type TEXT,
    verified_size_bytes BIGINT CHECK (
        verified_size_bytes IS NULL OR verified_size_bytes > 0
    ),
    verified_content_hash TEXT,
    security_scan_state TEXT NOT NULL DEFAULT 'pending' CHECK (
        security_scan_state IN (
            'pending',
            'clean',
            'suspicious',
            'malicious',
            'error',
            'not_required'
        )
    ),
    security_scan_profile TEXT,
    scanner_engine_version TEXT,
    scanner_signature_version TEXT,
    security_scan_result_ref TEXT,
    security_scanned_at TIMESTAMPTZ,
    plaintext_retention_state TEXT NOT NULL DEFAULT 'active' CHECK (
        plaintext_retention_state IN (
            'active',
            'purge_pending',
            'purged',
            'legal_hold'
        )
    ),
    plaintext_purged_at TIMESTAMPTZ,
    storage_ref TEXT NOT NULL UNIQUE,
    storage_provider TEXT,
    storage_bucket TEXT,
    storage_object_key TEXT,
    storage_endpoint TEXT,
    gateway_url TEXT,
    ipfs_cid TEXT,
    rejection_code TEXT,
    claim_kind TEXT CHECK (
        claim_kind IS NULL OR claim_kind IN (
            'asset_payload',
            'song_artifact',
            'deck_import'
        )
    ),
    claim_ref TEXT,
    claimed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT content_blobs_claim_pair_check CHECK (
        (claim_kind IS NULL) = (claim_ref IS NULL)
    ),
    CONSTRAINT content_blobs_scan_evidence_check CHECK (
        security_scan_state = 'pending'
        OR (
            security_scan_profile IS NOT NULL
            AND security_scan_result_ref IS NOT NULL
            AND security_scanned_at IS NOT NULL
        )
    ),
    CONSTRAINT content_blobs_clean_scanner_version_check CHECK (
        security_scan_state <> 'clean'
        OR (
            scanner_engine_version IS NOT NULL
            AND scanner_signature_version IS NOT NULL
        )
    ),
    CONSTRAINT content_blobs_plaintext_purge_check CHECK (
        (plaintext_retention_state = 'purged') = (plaintext_purged_at IS NOT NULL)
    ),
    CONSTRAINT content_blobs_ready_metadata_check CHECK (
        status <> 'ready'
        OR (
            detected_mime_type IS NOT NULL
            AND verified_size_bytes IS NOT NULL
            AND verified_content_hash IS NOT NULL
            AND security_scan_state IN ('clean', 'not_required')
        )
    )
);

CREATE INDEX idx_content_blobs_uploader_created
    ON content_blobs(uploader_user_id, created_at DESC);

CREATE INDEX idx_content_blobs_unclaimed_expiry
    ON content_blobs(status, created_at)
    WHERE claim_kind IS NULL;

CREATE UNIQUE INDEX idx_content_blobs_claim
    ON content_blobs(claim_kind, claim_ref)
    WHERE claim_kind IS NOT NULL;

CREATE TABLE content_upload_sessions (
    content_upload_session_id TEXT PRIMARY KEY,
    content_blob_id TEXT NOT NULL
        REFERENCES content_blobs(content_blob_id) ON DELETE CASCADE,
    uploader_user_id TEXT NOT NULL REFERENCES users(user_id),
    status TEXT NOT NULL CHECK (
        status IN (
            'created',
            'parts_uploading',
            'completing',
            'head_verifying',
            'uploaded',
            'aborting',
            'aborted'
        )
    ),
    upload_mode TEXT NOT NULL CHECK (
        upload_mode IN ('proxy', 'direct_multipart')
    ),
    object_key TEXT NOT NULL CHECK (length(trim(object_key)) > 0),
    provider_upload_id TEXT,
    part_size_bytes INTEGER CHECK (
        part_size_bytes IS NULL OR part_size_bytes > 0
    ),
    total_parts INTEGER CHECK (
        total_parts IS NULL OR total_parts > 0
    ),
    bucket TEXT NOT NULL CHECK (length(trim(bucket)) > 0),
    storage_endpoint TEXT NOT NULL CHECK (length(trim(storage_endpoint)) > 0),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    aborted_at TIMESTAMPTZ,
    aborted_reason TEXT
);

CREATE UNIQUE INDEX idx_content_upload_sessions_active_blob
    ON content_upload_sessions(content_blob_id)
    WHERE status NOT IN ('uploaded', 'aborted');

CREATE INDEX idx_content_upload_sessions_status_expires
    ON content_upload_sessions(status, expires_at);

REVOKE ALL ON TABLE content_blobs, content_upload_sessions FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE content_blobs, content_upload_sessions
TO control_plane_api_rw;

GRANT SELECT
ON TABLE content_blobs, content_upload_sessions
TO control_plane_api_ro, control_plane_ops_ro;
