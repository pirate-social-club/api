CREATE INDEX IF NOT EXISTS idx_story_registered_asset_projections_story_license_lookup
    ON story_registered_asset_projections(
      lower(story_ip_id),
      story_license_terms_id,
      created_at ASC,
      projection_id ASC
    )
    WHERE source_post_status = 'published';
