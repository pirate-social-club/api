CREATE INDEX idx_community_post_projections_author_identity_status_visibility_created
    ON community_post_projections(
        author_user_id,
        identity_mode,
        status,
        visibility,
        source_created_at DESC
    );
