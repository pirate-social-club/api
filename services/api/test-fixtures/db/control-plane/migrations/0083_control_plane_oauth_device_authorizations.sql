CREATE TABLE IF NOT EXISTS oauth_device_authorizations (
    device_code TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    user_id TEXT,
    scope TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'authorized', 'consumed', 'expired', 'revoked')
    ),
    access_token_hash TEXT,
    refresh_token_hash TEXT UNIQUE,
    expires_at INTEGER NOT NULL,
    authorized_at INTEGER,
    consumed_at INTEGER,
    token_expires_at INTEGER,
    refresh_expires_at INTEGER,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_device_user_code
    ON oauth_device_authorizations(user_code);

CREATE INDEX IF NOT EXISTS idx_oauth_device_expires
    ON oauth_device_authorizations(expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_device_refresh_token
    ON oauth_device_authorizations(client_id, refresh_token_hash)
    WHERE refresh_token_hash IS NOT NULL;
