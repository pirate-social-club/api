ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS display_verified_nationality_badge INTEGER NOT NULL DEFAULT 0;
