DO $$
BEGIN
  ALTER TABLE communities
    ADD COLUMN IF NOT EXISTS projected_follower_count INTEGER NOT NULL DEFAULT 0;
END $$;
