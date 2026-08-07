CREATE TABLE hns_import_session_locks (
    normalized_root_label TEXT PRIMARY KEY,
    namespace_verification_session_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_hns_import_session_locks_expires_at
    ON hns_import_session_locks(expires_at);
