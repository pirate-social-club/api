ALTER TABLE posts
  ADD COLUMN comments_locked INTEGER NOT NULL DEFAULT 0
  CHECK (comments_locked IN (0, 1));

ALTER TABLE posts
  ADD COLUMN comments_locked_at TEXT;

ALTER TABLE posts
  ADD COLUMN comments_locked_by_user_id TEXT;

ALTER TABLE posts
  ADD COLUMN comments_lock_reason TEXT;
