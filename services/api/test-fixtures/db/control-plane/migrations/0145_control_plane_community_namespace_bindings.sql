-- A community may attach one primary namespace and multiple independently
-- verified mirrors. communities.namespace_verification_id remains the
-- compatibility projection of the active primary during the API transition.
CREATE TABLE community_namespace_bindings (
    community_namespace_binding_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    namespace_verification_id TEXT NOT NULL,
    namespace_role TEXT NOT NULL CHECK (
        namespace_role IN ('primary', 'mirror')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('active', 'superseded', 'revoked')
    ),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_verification_id)
        REFERENCES namespace_verifications(namespace_verification_id)
);

CREATE UNIQUE INDEX idx_community_namespace_bindings_active_verification
    ON community_namespace_bindings(namespace_verification_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_community_namespace_bindings_active_primary
    ON community_namespace_bindings(community_id)
    WHERE status = 'active' AND namespace_role = 'primary';

CREATE INDEX idx_community_namespace_bindings_active_community
    ON community_namespace_bindings(community_id, namespace_role)
    WHERE status = 'active';

INSERT INTO community_namespace_bindings (
    community_namespace_binding_id,
    community_id,
    namespace_verification_id,
    namespace_role,
    status,
    created_at,
    updated_at
)
SELECT
    'cnb_' || community_id,
    community_id,
    namespace_verification_id,
    'primary',
    'active',
    created_at,
    updated_at
FROM communities
WHERE namespace_verification_id IS NOT NULL
ON CONFLICT DO NOTHING;
