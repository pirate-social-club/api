ALTER TABLE community_post_projections
    DROP CONSTRAINT IF EXISTS community_post_projections_status_check;

ALTER TABLE community_post_projections
    DROP CONSTRAINT IF EXISTS community_post_projections_status_check1;

ALTER TABLE community_post_projections
    ADD CONSTRAINT community_post_projections_status_check
    CHECK (status IN ('draft', 'processing', 'published', 'failed', 'hidden', 'removed', 'deleted'));
