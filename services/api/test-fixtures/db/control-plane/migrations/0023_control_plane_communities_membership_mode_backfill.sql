ALTER TABLE communities
    ADD COLUMN IF NOT EXISTS membership_mode TEXT NOT NULL DEFAULT 'open';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'communities_membership_mode_check'
    ) THEN
        ALTER TABLE communities
            ADD CONSTRAINT communities_membership_mode_check
            CHECK (membership_mode IN ('open', 'request', 'gated'));
    END IF;
END
$$;
