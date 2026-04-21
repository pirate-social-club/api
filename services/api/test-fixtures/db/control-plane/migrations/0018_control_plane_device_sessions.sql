PRAGMA foreign_keys = ON;

CREATE TABLE device_sessions (
    device_session_id TEXT PRIMARY KEY,
    device_code TEXT NOT NULL,
    user_code TEXT NOT NULL,
    authorized_user_id TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'authorized', 'completed', 'expired')
    ),
    client_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    authorized_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (authorized_user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX idx_device_sessions_device_code
    ON device_sessions(device_code);

CREATE UNIQUE INDEX idx_device_sessions_user_code_active
    ON device_sessions(user_code)
    WHERE status IN ('pending', 'authorized');

CREATE INDEX idx_device_sessions_status_expires
    ON device_sessions(status, expires_at);
