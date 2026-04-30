CREATE TABLE IF NOT EXISTS feed_post_projections (
    post_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    author_user_id TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'published', 'hidden', 'removed', 'deleted')
    ),
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (
        visibility IN ('public', 'members_only')
    ),
    published_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    upvote_count INTEGER NOT NULL DEFAULT 0,
    downvote_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    like_count INTEGER NOT NULL DEFAULT 0,
    post_type TEXT NOT NULL CHECK (
        post_type IN ('text', 'image', 'video', 'link', 'song')
    ),
    title TEXT,
    body_excerpt TEXT,
    caption_excerpt TEXT,
    media_refs_json JSONB,
    link_url TEXT,
    link_og_title TEXT,
    link_og_image_url TEXT,
    community_display_name TEXT NOT NULL,
    community_route_slug TEXT,
    community_avatar_ref TEXT,
    author_handle TEXT,
    author_display_name TEXT,
    author_avatar_ref TEXT,
    source_language TEXT,
    translation_policy TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    projection_updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX IF NOT EXISTS idx_feed_post_projections_new_public
    ON feed_post_projections(status, visibility, published_at DESC, post_id DESC);

CREATE INDEX IF NOT EXISTS idx_feed_post_projections_top_public
    ON feed_post_projections(status, visibility, score DESC, published_at DESC, post_id DESC);

CREATE INDEX IF NOT EXISTS idx_feed_post_projections_community
    ON feed_post_projections(community_id, status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_feed_post_projections_author
    ON feed_post_projections(author_user_id, status, published_at DESC);
