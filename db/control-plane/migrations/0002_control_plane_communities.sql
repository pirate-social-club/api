PRAGMA foreign_keys = ON;

CREATE TABLE communities (
    community_id TEXT PRIMARY KEY,
    creator_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'active', 'frozen', 'archived', 'deleted', 'suspended')
    ),
    provisioning_state TEXT NOT NULL CHECK (
        provisioning_state IN ('requested', 'provisioning', 'active', 'rotation_required', 'error')
    ),
    transfer_state TEXT NOT NULL CHECK (
        transfer_state IN ('none', 'pending', 'transferred', 'federated')
    ),
    route_slug TEXT,
    namespace_verification_id TEXT,
    primary_database_binding_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (creator_user_id) REFERENCES users(user_id),
    FOREIGN KEY (primary_database_binding_id) REFERENCES community_database_bindings(community_database_binding_id)
);

CREATE INDEX idx_communities_status_provisioning
    ON communities(status, provisioning_state);

CREATE UNIQUE INDEX idx_communities_route_slug
    ON communities(route_slug)
    WHERE route_slug IS NOT NULL;

CREATE TABLE community_database_bindings (
    community_database_binding_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    binding_role TEXT NOT NULL CHECK (
        binding_role IN ('primary', 'read_replica', 'archive')
    ),
    organization_slug TEXT NOT NULL,
    group_name TEXT NOT NULL,
    group_id TEXT,
    database_name TEXT NOT NULL,
    database_id TEXT,
    database_url TEXT NOT NULL,
    location TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'inactive', 'pending_transfer', 'superseded', 'error')
    ),
    transferred_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_community_bindings_active_role
    ON community_database_bindings(community_id, binding_role)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_community_bindings_active_target
    ON community_database_bindings(organization_slug, group_name, database_name)
    WHERE status IN ('active', 'pending_transfer');

CREATE TABLE community_db_credentials (
    community_db_credential_id TEXT PRIMARY KEY,
    community_database_binding_id TEXT NOT NULL,
    credential_kind TEXT NOT NULL CHECK (
        credential_kind IN ('database_token', 'group_token')
    ),
    token_name TEXT NOT NULL,
    encrypted_token TEXT NOT NULL,
    encryption_key_version INTEGER NOT NULL,
    token_scope TEXT NOT NULL CHECK (
        token_scope IN ('database', 'group')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('active', 'superseded', 'invalidated')
    ),
    issued_at TEXT NOT NULL,
    invalidated_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_database_binding_id) REFERENCES community_database_bindings(community_database_binding_id)
);

CREATE UNIQUE INDEX idx_community_db_credentials_active_binding
    ON community_db_credentials(community_database_binding_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_community_db_credentials_token_name
    ON community_db_credentials(token_name);

CREATE TABLE community_post_projections (
    projection_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    source_post_id TEXT NOT NULL,
    author_user_id TEXT,
    identity_mode TEXT NOT NULL CHECK (
        identity_mode IN ('public', 'anonymous')
    ),
    post_type TEXT NOT NULL CHECK (
        post_type IN ('text', 'image', 'video', 'link', 'song')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'published', 'hidden', 'removed', 'deleted')
    ),
    source_created_at TEXT NOT NULL,
    projected_payload_json TEXT NOT NULL,
    projection_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_post_projections_club_created
    ON community_post_projections(community_id, source_created_at DESC);

CREATE INDEX idx_community_post_projections_status_created
    ON community_post_projections(status, source_created_at DESC);

CREATE UNIQUE INDEX idx_community_post_projections_source_version
    ON community_post_projections(community_id, source_post_id, projection_version);

CREATE TABLE community_membership_projections (
    projection_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    membership_state TEXT NOT NULL CHECK (
        membership_state IN ('not_member', 'pending_request', 'member', 'banned')
    ),
    role_summary_json TEXT,
    source_updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX idx_community_membership_projections_unique
    ON community_membership_projections(community_id, user_id);

CREATE INDEX idx_community_membership_projections_user_state
    ON community_membership_projections(user_id, membership_state);
