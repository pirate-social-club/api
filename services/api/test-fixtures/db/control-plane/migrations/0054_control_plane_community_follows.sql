ALTER TABLE communities
    ADD COLUMN projected_follower_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE community_follow_projections (
    projection_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    follow_state TEXT NOT NULL CHECK (
        follow_state IN ('active', 'inactive')
    ),
    source_updated_at TEXT NOT NULL,
    unfollowed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX idx_community_follow_projections_unique
    ON community_follow_projections(community_id, user_id);

CREATE INDEX idx_community_follow_projections_user_state
    ON community_follow_projections(user_id, follow_state);
