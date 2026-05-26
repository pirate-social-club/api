ALTER TABLE song_artifact_uploads RENAME TO song_artifact_uploads_old;

CREATE TABLE song_artifact_uploads (
    song_artifact_upload_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    uploader_user_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL CHECK (
        artifact_kind IN ('primary_audio', 'cover_art', 'preview_audio', 'preview_video', 'canvas_video', 'instrumental_audio', 'vocal_audio', 'primary_video')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('pending_upload', 'uploaded', 'failed')
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
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (uploader_user_id) REFERENCES users(user_id)
);

INSERT INTO song_artifact_uploads (
    song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
    mime_type, filename, size_bytes, content_hash, blob_path, storage_provider, storage_bucket,
    storage_object_key, storage_endpoint, gateway_url, created_at, updated_at
)
SELECT
    song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
    mime_type, filename, size_bytes, content_hash, blob_path, storage_provider, storage_bucket,
    storage_object_key, storage_endpoint, gateway_url, created_at, updated_at
FROM song_artifact_uploads_old;

DROP TABLE song_artifact_uploads_old;

CREATE INDEX idx_song_artifact_uploads_community_created
    ON song_artifact_uploads(community_id, created_at DESC);

CREATE INDEX idx_song_artifact_uploads_uploader_created
    ON song_artifact_uploads(uploader_user_id, created_at DESC);
