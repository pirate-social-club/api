ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS banner_ref TEXT;
