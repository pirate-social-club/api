ALTER TABLE communities
    ADD COLUMN IF NOT EXISTS pending_namespace_verification_session_id TEXT;
