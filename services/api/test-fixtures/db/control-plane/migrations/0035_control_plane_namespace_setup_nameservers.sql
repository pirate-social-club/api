ALTER TABLE namespace_verification_sessions
    ADD COLUMN IF NOT EXISTS setup_nameservers_json JSONB;
