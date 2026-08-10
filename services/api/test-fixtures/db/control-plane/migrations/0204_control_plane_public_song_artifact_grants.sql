CREATE TABLE public_song_artifact_grants (
    community_id TEXT NOT NULL,
    song_artifact_upload_id TEXT NOT NULL,
    source_post_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (community_id, song_artifact_upload_id, source_post_id),
    CONSTRAINT fk_public_song_artifact_grant_community
        FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_public_song_artifact_grants_lookup
    ON public_song_artifact_grants(community_id, song_artifact_upload_id);
