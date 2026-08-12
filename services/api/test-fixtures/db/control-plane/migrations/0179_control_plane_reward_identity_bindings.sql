-- Explicit reward-document selection. Existing users are intentionally left
-- unbound; historical evidence is classified separately before any backfill.
CREATE TABLE reward_identity_bindings (
    reward_identity_binding_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    identity_nullifier_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
    selected_at TIMESTAMPTZ NOT NULL,
    superseded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (identity_nullifier_id) REFERENCES identity_nullifiers(identity_nullifier_id),
    CONSTRAINT reward_identity_bindings_status_timestamps_check CHECK (
        (status = 'active' AND superseded_at IS NULL)
        OR (status = 'superseded' AND superseded_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_reward_identity_bindings_user_active
    ON reward_identity_bindings(user_id)
    WHERE status = 'active';

CREATE INDEX idx_reward_identity_bindings_nullifier_status
    ON reward_identity_bindings(identity_nullifier_id, status);
