CREATE TABLE IF NOT EXISTS community_assistant_credentials (
    community_assistant_credential_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'openrouter' CHECK (
        provider IN ('openrouter')
    ),
    encrypted_secret TEXT NOT NULL,
    key_last4 TEXT NOT NULL,
    encryption_key_version INTEGER NOT NULL DEFAULT 1 CHECK (
        encryption_key_version > 0
    ),
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'revoked', 'invalid')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    rotated_from TEXT,
    actor_user_id TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (rotated_from) REFERENCES community_assistant_credentials(community_assistant_credential_id),
    FOREIGN KEY (actor_user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_credentials_active_provider
    ON community_assistant_credentials(community_id, provider)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_assistant_credentials_community
    ON community_assistant_credentials(community_id, status, created_at DESC);
