CREATE TABLE identity_nullifiers (
    identity_nullifier_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (
        provider IN ('self', 'very')
    ),
    mechanism TEXT NOT NULL CHECK (
        mechanism IN ('zk-nullifier', 'palm-nullifier')
    ),
    nullifier_hash TEXT NOT NULL,
    source_verification_session_id TEXT,
    source_user_attestation_id TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'revoked', 'superseded')
    ),
    first_seen_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (source_verification_session_id) REFERENCES verification_sessions(verification_session_id),
    FOREIGN KEY (source_user_attestation_id) REFERENCES user_attestations(user_attestation_id)
);

CREATE UNIQUE INDEX idx_identity_nullifiers_active_unique
    ON identity_nullifiers(provider, mechanism, nullifier_hash)
    WHERE status = 'active';

CREATE INDEX idx_identity_nullifiers_user_status
    ON identity_nullifiers(user_id, status, first_seen_at DESC);
