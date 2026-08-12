-- Durable operator confirmation for wallet-capable app.<root> origins.
--
-- Absence is disabled. Registration is intentionally independent of verifier
-- freshness: transient observation outages must not withdraw an already
-- activated wallet origin. Effective access additionally requires the root's
-- durable routing activation and the absence of a hard deny at read time.

CREATE TABLE hns_wallet_origin_authority (
    normalized_root_label TEXT PRIMARY KEY,
    origin_hostname TEXT NOT NULL UNIQUE,
    registration_status TEXT NOT NULL CHECK (
        registration_status IN ('registered', 'revoked')
    ),
    authority_version BIGINT NOT NULL DEFAULT 1 CHECK (authority_version > 0),
    registration_reference TEXT NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL,
    registered_by TEXT NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoked_by TEXT,
    revocation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (normalized_root_label)
        REFERENCES hns_root_delegation_state(normalized_root_label),
    CONSTRAINT hns_wallet_origin_authority_hostname_matches_root CHECK (
        origin_hostname = 'app.' || normalized_root_label
    ),
    CONSTRAINT hns_wallet_origin_authority_revocation_coherent CHECK (
        (registration_status = 'registered'
            AND revoked_at IS NULL
            AND revoked_by IS NULL
            AND revocation_reason IS NULL)
        OR
        (registration_status = 'revoked'
            AND revoked_at IS NOT NULL
            AND revoked_by IS NOT NULL
            AND revocation_reason IS NOT NULL)
    )
);

CREATE INDEX idx_hns_wallet_origin_authority_effective
    ON hns_wallet_origin_authority(registration_status, normalized_root_label);
