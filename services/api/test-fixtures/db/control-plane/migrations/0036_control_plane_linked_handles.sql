CREATE TABLE IF NOT EXISTS linked_handles (
    linked_handle_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    wallet_attachment_id TEXT,
    kind TEXT NOT NULL CHECK (
        kind IN ('pirate', 'ens')
    ),
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    verification_state TEXT NOT NULL CHECK (
        verification_state IN ('verified', 'unverified', 'stale')
    ),
    metadata_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (wallet_attachment_id) REFERENCES wallet_attachments(wallet_attachment_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_handles_user_kind_label
    ON linked_handles(user_id, kind, label_normalized);

CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_handles_wallet_kind
    ON linked_handles(wallet_attachment_id, kind)
    WHERE wallet_attachment_id IS NOT NULL;

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS primary_linked_handle_id TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'profiles_primary_linked_handle_id_fkey'
          AND table_name = 'profiles'
    ) THEN
        ALTER TABLE profiles
            ADD CONSTRAINT profiles_primary_linked_handle_id_fkey
            FOREIGN KEY (primary_linked_handle_id) REFERENCES linked_handles(linked_handle_id);
    END IF;
END $$;
