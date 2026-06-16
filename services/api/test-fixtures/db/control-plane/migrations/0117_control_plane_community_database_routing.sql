CREATE TABLE community_database_routing (
    community_id TEXT PRIMARY KEY,
    backend TEXT NOT NULL CHECK (backend IN ('turso', 'd1')),
    provisioning_state TEXT NOT NULL CHECK (
        provisioning_state IN ('provisioning', 'ready', 'degraded', 'decommissioned')
    ),

    shard_worker_id TEXT,
    binding_name TEXT,
    region TEXT,
    turso_database_binding_id TEXT,

    migrated_at TIMESTAMPTZ,
    decommissioned_at TIMESTAMPTZ,
    last_error_at TIMESTAMPTZ,
    last_error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,

    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (turso_database_binding_id) REFERENCES community_database_bindings(community_database_binding_id),

    CONSTRAINT chk_d1_fields CHECK (
        (backend = 'd1' AND shard_worker_id IS NOT NULL AND binding_name IS NOT NULL AND region IS NOT NULL
            AND turso_database_binding_id IS NULL)
        OR (backend = 'turso' AND shard_worker_id IS NULL AND binding_name IS NULL AND region IS NULL
            AND turso_database_binding_id IS NOT NULL)
    ),
    CONSTRAINT chk_migrated_at CHECK (
        migrated_at IS NULL OR backend = 'd1'
    ),
    CONSTRAINT chk_decommissioned_at CHECK (
        decommissioned_at IS NULL OR provisioning_state = 'decommissioned'
    )
);

CREATE INDEX idx_community_database_routing_state
    ON community_database_routing(provisioning_state);

CREATE INDEX idx_community_database_routing_shard
    ON community_database_routing(shard_worker_id)
    WHERE backend = 'd1' AND provisioning_state = 'ready';
