ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS avatar_ref TEXT;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS membership_has_altcha_pow INTEGER NOT NULL DEFAULT 0 CHECK (
    membership_has_altcha_pow IN (0, 1)
  );

CREATE INDEX IF NOT EXISTS idx_communities_postable_unlock
  ON communities(membership_has_altcha_pow, status, provisioning_state, follower_count DESC, created_at DESC)
  WHERE membership_has_altcha_pow = 1;
