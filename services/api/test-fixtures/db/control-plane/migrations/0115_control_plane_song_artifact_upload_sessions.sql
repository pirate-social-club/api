ALTER TABLE song_artifact_uploads RENAME TO song_artifact_uploads_old;

CREATE TABLE song_artifact_uploads (
    song_artifact_upload_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    uploader_user_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL CHECK (
        artifact_kind IN ('primary_audio', 'cover_art', 'preview_audio', 'preview_video', 'canvas_video', 'instrumental_audio', 'vocal_audio', 'primary_video')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('pending_upload', 'uploaded', 'failed', 'cancelled')
    ),
    storage_ref TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    filename TEXT,
    size_bytes INTEGER,
    content_hash TEXT,
    blob_path TEXT,
    storage_provider TEXT,
    storage_bucket TEXT,
    storage_object_key TEXT,
    storage_endpoint TEXT,
    gateway_url TEXT,
    ipfs_cid TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (uploader_user_id) REFERENCES users(user_id)
);

INSERT INTO song_artifact_uploads (
    song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
    mime_type, filename, size_bytes, content_hash, blob_path, storage_provider, storage_bucket,
    storage_object_key, storage_endpoint, gateway_url, ipfs_cid, created_at, updated_at
)
SELECT
    song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
    mime_type, filename, size_bytes, content_hash, blob_path, storage_provider, storage_bucket,
    storage_object_key, storage_endpoint, gateway_url, ipfs_cid, created_at, updated_at
FROM song_artifact_uploads_old;

DROP TABLE song_artifact_uploads_old;

CREATE INDEX idx_song_artifact_uploads_community_created
    ON song_artifact_uploads(community_id, created_at DESC);

CREATE INDEX idx_song_artifact_uploads_uploader_created
    ON song_artifact_uploads(uploader_user_id, created_at DESC);

CREATE TABLE song_artifact_upload_sessions (
    song_artifact_upload_session_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    song_artifact_upload_id TEXT NOT NULL,
    uploader_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('created', 'parts_uploading', 'completing', 'head_verifying', 'uploaded', 'aborting', 'aborted')
    ),
    upload_mode TEXT NOT NULL CHECK (
        upload_mode IN ('proxy', 'direct_multipart')
    ),
    object_key TEXT NOT NULL,
    filebase_upload_id TEXT,
    part_size_bytes INTEGER,
    total_parts INTEGER,
    declared_size_bytes INTEGER NOT NULL,
    declared_mime_type TEXT NOT NULL,
    declared_content_hash TEXT,
    bucket TEXT NOT NULL,
    storage_endpoint TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    storage_provider TEXT,
    storage_object_key TEXT,
    storage_bucket TEXT,
    gateway_url TEXT,
    ipfs_cid TEXT,
    content_hash TEXT,
    size_bytes INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    aborted_at TEXT,
    aborted_reason TEXT,
    CONSTRAINT fk_session_upload FOREIGN KEY (song_artifact_upload_id)
        REFERENCES song_artifact_uploads(song_artifact_upload_id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX uniq_active_session_per_upload
    ON song_artifact_upload_sessions(song_artifact_upload_id)
    WHERE status NOT IN ('uploaded', 'aborted');

CREATE INDEX idx_song_artifact_upload_sessions_status_expires
    ON song_artifact_upload_sessions(status, expires_at);

CREATE INDEX idx_song_artifact_upload_sessions_community_status_created
    ON song_artifact_upload_sessions(community_id, status, created_at);
