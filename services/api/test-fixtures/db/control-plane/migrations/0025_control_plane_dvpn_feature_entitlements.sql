CREATE TABLE dvpn_feature_entitlements (
    dvpn_feature_entitlement_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'expired', 'revoked')
    ),
    purchase_ref TEXT,
    payment_provider TEXT,
    activated_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_dvpn_feature_entitlements_user_status
    ON dvpn_feature_entitlements(user_id, status, activated_at DESC);
