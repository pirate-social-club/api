CREATE UNIQUE INDEX idx_sentinel_sessions_chain_session_id
    ON sentinel_sessions(chain_session_id);

CREATE UNIQUE INDEX idx_sentinel_sessions_active_user
    ON sentinel_sessions(user_id)
    WHERE status = 'active';
