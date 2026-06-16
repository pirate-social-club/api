CREATE TABLE karaoke_session_creation_requests (
    subject_user_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'initialized', 'failed')),
    session_id TEXT,
    attempt_id TEXT,
    websocket_base_url TEXT,
    protocol_version INTEGER,
    scoring_policy_json TEXT,
    session_expires_at TEXT,
    token_issued_at INTEGER,
    token_expires_at INTEGER,
    token_nonce TEXT,
    failure_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (subject_user_id, community_id, post_id, idempotency_key)
);

CREATE INDEX idx_karaoke_session_creation_requests_expires
    ON karaoke_session_creation_requests(status, expires_at);
