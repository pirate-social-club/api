ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS xmtp_inbox_id TEXT;
