ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS avatar_source TEXT CHECK (avatar_source IS NULL OR avatar_source IN ('ens', 'upload', 'none'));

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS cover_source TEXT CHECK (cover_source IS NULL OR cover_source IN ('ens', 'upload', 'none'));

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS bio_source TEXT CHECK (bio_source IS NULL OR bio_source IN ('ens', 'manual', 'none'));
