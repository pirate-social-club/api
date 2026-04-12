CREATE TABLE song_artifact_uploads (
    song_artifact_upload_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    uploader_user_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL CHECK (
        artifact_kind IN ('primary_audio', 'cover_art', 'preview_audio', 'canvas_video', 'instrumental_audio', 'vocal_audio')
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (uploader_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_song_artifact_uploads_community_created
    ON song_artifact_uploads(community_id, created_at DESC);

CREATE INDEX idx_song_artifact_uploads_uploader_created
    ON song_artifact_uploads(uploader_user_id, created_at DESC);
