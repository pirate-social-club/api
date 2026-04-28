DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'communities'
      AND column_name = 'projected_follower_count'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'communities'
      AND column_name = 'follower_count'
  ) THEN
    ALTER TABLE communities
      RENAME COLUMN projected_follower_count TO follower_count;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'communities'
      AND column_name = 'follower_count'
  ) THEN
    ALTER TABLE communities
      ADD COLUMN follower_count INTEGER NOT NULL DEFAULT 0;
  END IF;

  ALTER TABLE communities
    ALTER COLUMN follower_count SET DEFAULT 0,
    ALTER COLUMN follower_count SET NOT NULL;
END $$;
