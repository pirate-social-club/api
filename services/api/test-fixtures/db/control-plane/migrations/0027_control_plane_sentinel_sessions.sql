CREATE TABLE sentinel_sessions (
    sentinel_session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    sentinel_subscription_id TEXT NOT NULL,
    wallet_attachment_id TEXT NOT NULL,
    chain_session_id TEXT NOT NULL,
    node_address TEXT NOT NULL,
    transport_kind TEXT NOT NULL CHECK (
        transport_kind IN ('wireguard')
    ),
    connection_payload_json JSONB NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('starting', 'active', 'ended', 'failed')
    ),
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (sentinel_subscription_id) REFERENCES sentinel_subscriptions(sentinel_subscription_id),
    FOREIGN KEY (wallet_attachment_id) REFERENCES wallet_attachments(wallet_attachment_id)
);

CREATE INDEX idx_sentinel_sessions_user_status
    ON sentinel_sessions(user_id, status, started_at DESC);
