CREATE TABLE sentinel_subscriptions (
    sentinel_subscription_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    wallet_attachment_id TEXT NOT NULL,
    dvpn_feature_entitlement_id TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    plan_key TEXT NOT NULL,
    chain_subscription_id TEXT NOT NULL,
    allocation_tx_hash TEXT,
    allocated_bytes BIGINT,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'expired', 'revoked', 'exhausted')
    ),
    activated_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (wallet_attachment_id) REFERENCES wallet_attachments(wallet_attachment_id),
    FOREIGN KEY (dvpn_feature_entitlement_id) REFERENCES dvpn_feature_entitlements(dvpn_feature_entitlement_id)
);

CREATE INDEX idx_sentinel_subscriptions_user_status
    ON sentinel_subscriptions(user_id, status, activated_at DESC);
