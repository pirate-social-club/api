ALTER TABLE community_post_projections RENAME TO community_post_projections_old;

CREATE TABLE community_post_projections (
    projection_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    source_post_id TEXT NOT NULL,
    author_user_id TEXT,
    identity_mode TEXT NOT NULL CHECK (
        identity_mode IN ('public', 'anonymous')
    ),
    post_type TEXT NOT NULL CHECK (
        post_type IN ('text', 'image', 'video', 'link', 'song', 'crosspost')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'published', 'hidden', 'removed', 'deleted')
    ),
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (
        visibility IN ('public', 'members_only')
    ),
    upvote_count INTEGER NOT NULL DEFAULT 0,
    downvote_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    like_count INTEGER NOT NULL DEFAULT 0,
    source_created_at TIMESTAMPTZ NOT NULL,
    projected_payload_json JSONB NOT NULL,
    projection_version INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

INSERT INTO community_post_projections (
    projection_id, community_id, source_post_id, author_user_id, identity_mode, post_type,
    status, visibility, upvote_count, downvote_count, comment_count, like_count,
    source_created_at, projected_payload_json, projection_version, created_at, updated_at
)
SELECT
    projection_id, community_id, source_post_id, author_user_id, identity_mode, post_type,
    status, visibility, upvote_count, downvote_count, comment_count, like_count,
    source_created_at, projected_payload_json, projection_version, created_at, updated_at
FROM community_post_projections_old;

DROP TABLE community_post_projections_old;

CREATE INDEX idx_community_post_projections_club_created
    ON community_post_projections(community_id, source_created_at DESC);

CREATE INDEX idx_community_post_projections_status_created
    ON community_post_projections(status, source_created_at DESC);

CREATE INDEX idx_community_post_projections_published_score_created
    ON community_post_projections(
        status,
        community_id,
        (upvote_count - downvote_count) DESC,
        source_created_at DESC,
        source_post_id DESC
    );

CREATE UNIQUE INDEX idx_community_post_projections_source_version
    ON community_post_projections(community_id, source_post_id, projection_version);

ALTER TABLE feed_post_projections RENAME TO feed_post_projections_old;

CREATE TABLE feed_post_projections (
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
        post_type IN ('text', 'image', 'video', 'link', 'song', 'crosspost')
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
    authorship_mode TEXT NOT NULL DEFAULT 'human_direct' CHECK (
        authorship_mode IN ('human_direct', 'user_agent')
    ),
    agent_id TEXT,
    agent_ownership_record_id TEXT,
    agent_handle_snapshot TEXT,
    agent_display_name_snapshot TEXT,
    agent_owner_handle_snapshot TEXT,
    agent_ownership_provider_snapshot JSONB,
    identity_mode TEXT NOT NULL DEFAULT 'public' CHECK (
        identity_mode IN ('public', 'anonymous')
    ),
    anonymous_scope TEXT CHECK (
        anonymous_scope IN ('community_stable', 'thread_stable', 'post_ephemeral')
    ),
    anonymous_label TEXT,
    source_hash TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

INSERT INTO feed_post_projections (
    post_id, community_id, author_user_id, status, visibility, published_at, updated_at,
    score, upvote_count, downvote_count, comment_count, like_count, post_type, title,
    body_excerpt, caption_excerpt, media_refs_json, link_url, link_og_title,
    link_og_image_url, community_display_name, community_route_slug, community_avatar_ref,
    author_handle, author_display_name, author_avatar_ref, source_language, translation_policy,
    created_at, projection_updated_at, authorship_mode, agent_id, agent_ownership_record_id,
    agent_handle_snapshot, agent_display_name_snapshot, agent_owner_handle_snapshot,
    agent_ownership_provider_snapshot, identity_mode, anonymous_scope, anonymous_label,
    source_hash
)
SELECT
    post_id, community_id, author_user_id, status, visibility, published_at, updated_at,
    score, upvote_count, downvote_count, comment_count, like_count, post_type, title,
    body_excerpt, caption_excerpt, media_refs_json, link_url, link_og_title,
    link_og_image_url, community_display_name, community_route_slug, community_avatar_ref,
    author_handle, author_display_name, author_avatar_ref, source_language, translation_policy,
    created_at, projection_updated_at, authorship_mode, agent_id, agent_ownership_record_id,
    agent_handle_snapshot, agent_display_name_snapshot, agent_owner_handle_snapshot,
    agent_ownership_provider_snapshot, identity_mode, anonymous_scope, anonymous_label,
    source_hash
FROM feed_post_projections_old;

DROP TABLE feed_post_projections_old;

CREATE INDEX idx_feed_post_projections_new_public
    ON feed_post_projections(status, visibility, published_at DESC, post_id DESC);

CREATE INDEX idx_feed_post_projections_top_public
    ON feed_post_projections(status, visibility, score DESC, published_at DESC, post_id DESC);

CREATE INDEX idx_feed_post_projections_community
    ON feed_post_projections(community_id, status, published_at DESC);

CREATE INDEX idx_feed_post_projections_author
    ON feed_post_projections(author_user_id, status, published_at DESC);
