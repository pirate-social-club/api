ALTER TABLE sentinel_sessions
    ADD COLUMN expires_at TIMESTAMPTZ,
    ADD COLUMN start_idempotency_key TEXT;

CREATE UNIQUE INDEX idx_sentinel_sessions_user_start_idempotency
    ON sentinel_sessions(user_id, start_idempotency_key)
    WHERE start_idempotency_key IS NOT NULL;
