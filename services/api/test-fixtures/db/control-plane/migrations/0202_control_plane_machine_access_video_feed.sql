ALTER TABLE machine_access_overrides
    DROP CONSTRAINT machine_access_overrides_surface_check;

-- migration-safety: existing-table-check-reviewed: the replacement only adds video_feed to the previously accepted values
ALTER TABLE machine_access_overrides
    ADD CONSTRAINT machine_access_overrides_surface_check CHECK (
        surface IN ('all', 'community_stats', 'video_feed', 'thread_cards', 'thread_bodies', 'top_comments', 'events')
    );
