ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS explicit_content_preference TEXT NOT NULL DEFAULT 'show'
    CHECK (explicit_content_preference IN ('show', 'hide'));
