ALTER TABLE feed_post_projections
    ADD COLUMN IF NOT EXISTS authorship_mode TEXT NOT NULL DEFAULT 'human_direct' CHECK (
        authorship_mode IN ('human_direct', 'user_agent')
    );

ALTER TABLE feed_post_projections
    ADD COLUMN IF NOT EXISTS agent_id TEXT;

ALTER TABLE feed_post_projections
    ADD COLUMN IF NOT EXISTS agent_ownership_record_id TEXT;

ALTER TABLE feed_post_projections
    ADD COLUMN IF NOT EXISTS agent_handle_snapshot TEXT;

ALTER TABLE feed_post_projections
    ADD COLUMN IF NOT EXISTS agent_display_name_snapshot TEXT;

ALTER TABLE feed_post_projections
    ADD COLUMN IF NOT EXISTS agent_owner_handle_snapshot TEXT;

ALTER TABLE feed_post_projections
    ADD COLUMN IF NOT EXISTS agent_ownership_provider_snapshot JSONB;

ALTER TABLE feed_post_projections
    ADD COLUMN IF NOT EXISTS identity_mode TEXT NOT NULL DEFAULT 'public' CHECK (
        identity_mode IN ('public', 'anonymous')
    );

ALTER TABLE feed_post_projections
    ADD COLUMN IF NOT EXISTS anonymous_scope TEXT CHECK (
        anonymous_scope IN ('community_stable', 'thread_stable', 'post_ephemeral')
    );

ALTER TABLE feed_post_projections
    ADD COLUMN IF NOT EXISTS anonymous_label TEXT;

ALTER TABLE feed_post_projections
    ADD COLUMN IF NOT EXISTS source_hash TEXT;
