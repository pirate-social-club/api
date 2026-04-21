ALTER TABLE community_post_projections
  ADD COLUMN upvote_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE community_post_projections
  ADD COLUMN downvote_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE community_post_projections
  ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE community_post_projections
  ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_community_post_projections_published_score_created
  ON community_post_projections(
    status,
    community_id,
    (upvote_count - downvote_count) DESC,
    source_created_at DESC,
    source_post_id DESC
  );
