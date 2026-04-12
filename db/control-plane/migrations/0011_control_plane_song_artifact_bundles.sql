CREATE TABLE song_artifact_bundles (
    song_artifact_bundle_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    creator_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'validating', 'ready', 'consuming', 'consumed', 'failed')
    ),
    primary_audio_json TEXT NOT NULL,
    lyrics_text TEXT NOT NULL,
    lyrics_sha256 TEXT NOT NULL,
    cover_art_json TEXT,
    preview_audio_json TEXT,
    canvas_video_json TEXT,
    instrumental_audio_json TEXT,
    vocal_audio_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (creator_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_song_artifact_bundles_community_created
    ON song_artifact_bundles(community_id, created_at DESC);

CREATE INDEX idx_song_artifact_bundles_creator_created
    ON song_artifact_bundles(creator_user_id, created_at DESC);
