CREATE TABLE IF NOT EXISTS comment_projections (
    projection_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    thread_root_post_id TEXT NOT NULL,
    source_comment_id TEXT NOT NULL,
    parent_comment_id TEXT,
    depth INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('published', 'hidden', 'removed', 'deleted')
    ),
    source_created_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_projections_source_comment
    ON comment_projections(community_id, source_comment_id);

CREATE INDEX IF NOT EXISTS idx_comment_projections_thread_created
    ON comment_projections(thread_root_post_id, source_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comment_projections_comment_id
    ON comment_projections(source_comment_id);
