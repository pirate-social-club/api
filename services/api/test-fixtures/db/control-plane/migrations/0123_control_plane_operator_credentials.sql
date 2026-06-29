-- Operator credentials for individually attributable, separately revocable privileged actions
-- such as booking settlement resolution. Each row is a distinct credential with its own id, a
-- service-principal actor id, a hashed secret, stored scopes, an expiry, and revocation state.
-- This is deliberately NOT the shared admin token: a financial decision must be attributable to
-- one revocable, expiring credential, never a bearer shared across operators.
--
-- Hashing: secret_hash is a digest of a CRYPTOGRAPHICALLY RANDOM high-entropy secret (never a
-- human password), so a fast digest is acceptable. secret_hash_algo and secret_hash_version make
-- the scheme explicitly migratable.
--
-- Apply as control_plane_migrator so the table is migrator-owned. The schema-wide default
-- privileges grant the API runtime full write on every new table, which would let a compromised
-- runtime mint, rescope, reactivate, or erase credentials. The REVOKE plus narrow GRANT below
-- make this table an independent boundary: the runtime gets SELECT plus a single column-level
-- UPDATE for the throttled last_used_at touch only. Issuance, rotation, and revocation run as the
-- owning migrator role, never the runtime.

CREATE TABLE operator_credentials (
    operator_credential_id TEXT PRIMARY KEY,
    operator_actor_id TEXT NOT NULL,
    label TEXT NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    secret_hash_algo TEXT NOT NULL CHECK (secret_hash_algo IN ('sha256')),
    secret_hash_version INTEGER NOT NULL CHECK (secret_hash_version >= 1),
    scopes_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    rotated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    superseded_by_credential_id TEXT REFERENCES operator_credentials (operator_credential_id),
    CONSTRAINT chk_operator_credential_revoked CHECK (
        (status = 'revoked') = (revoked_at IS NOT NULL)
    ),
    CONSTRAINT chk_operator_credential_no_self_supersede CHECK (
        superseded_by_credential_id IS NULL OR superseded_by_credential_id <> operator_credential_id
    ),
    CONSTRAINT chk_operator_credential_superseded_pairs_rotated CHECK (
        (superseded_by_credential_id IS NULL) = (rotated_at IS NULL)
    ),
    CONSTRAINT chk_operator_credential_superseded_requires_revoked CHECK (
        superseded_by_credential_id IS NULL OR status = 'revoked'
    ),
    CONSTRAINT chk_operator_credential_expires_after_created CHECK (
        expires_at > created_at
    )
);

CREATE INDEX operator_credentials_status_idx ON operator_credentials (status);
CREATE INDEX operator_credentials_actor_idx ON operator_credentials (operator_actor_id);

REVOKE ALL ON TABLE operator_credentials FROM control_plane_api_rw;
REVOKE ALL ON TABLE operator_credentials FROM control_plane_api_ro;
REVOKE ALL ON TABLE operator_credentials FROM control_plane_ops_ro;
GRANT SELECT ON TABLE operator_credentials TO control_plane_api_rw;
GRANT UPDATE (last_used_at) ON TABLE operator_credentials TO control_plane_api_rw;
GRANT SELECT ON TABLE operator_credentials TO control_plane_api_ro;
GRANT SELECT ON TABLE operator_credentials TO control_plane_ops_ro;
