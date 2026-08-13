-- Story registration projections must admit every first-class asset kind before
-- a community writer can publish generic goods.
ALTER TABLE story_registered_asset_projections
    DROP CONSTRAINT story_registered_asset_projections_asset_kind_check;

-- migration-safety: existing-table-check-reviewed: every existing row already uses song_audio or video_file, both retained below
ALTER TABLE story_registered_asset_projections
    ADD CONSTRAINT story_registered_asset_projections_asset_kind_check CHECK (
        asset_kind IN ('song_audio', 'video_file', 'download_file', 'learning_deck')
    );
