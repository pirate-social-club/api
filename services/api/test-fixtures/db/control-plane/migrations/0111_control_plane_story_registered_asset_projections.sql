CREATE TABLE story_registered_asset_projections (
    projection_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    display_title TEXT,
    creator_user_id TEXT NOT NULL,
    asset_kind TEXT NOT NULL CHECK (asset_kind IN ('song_audio', 'video_file')),
    license_preset TEXT,
    commercial_rev_share_pct INTEGER,
    story_ip_id TEXT NOT NULL,
    story_license_terms_id TEXT,
    source_post_id TEXT NOT NULL,
    source_post_status TEXT NOT NULL DEFAULT 'published',
    source_updated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_story_registered_asset_projections_kind_updated
    ON story_registered_asset_projections(asset_kind, updated_at DESC)
    WHERE source_post_status = 'published';

CREATE INDEX idx_story_registered_asset_projections_kind_title
    ON story_registered_asset_projections(asset_kind, lower(display_title))
    WHERE source_post_status = 'published';

CREATE UNIQUE INDEX idx_story_registered_asset_projections_unique
    ON story_registered_asset_projections(community_id, asset_id);

CREATE INDEX idx_story_registered_asset_projections_post_status
    ON story_registered_asset_projections(source_post_status, updated_at);
