PRAGMA foreign_keys = ON;

CREATE TABLE users (
    user_id TEXT PRIMARY KEY,
    primary_wallet_attachment_id TEXT,
    verification_state TEXT NOT NULL CHECK (
        verification_state IN ('unverified', 'pending', 'verified', 'reverification_required')
    ),
    capability_provider TEXT CHECK (
        capability_provider IS NULL OR capability_provider IN ('self', 'very', 'passport', 'zkpass')
    ),
    verification_capabilities_json TEXT NOT NULL,
    verified_at TEXT,
    nationality TEXT,
    current_verification_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_users_verification_state
    ON users(verification_state);

CREATE TABLE wallet_attachments (
    wallet_attachment_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chain_namespace TEXT NOT NULL,
    wallet_address_normalized TEXT NOT NULL,
    wallet_address_display TEXT NOT NULL,
    source_provider TEXT,
    source_subject TEXT,
    attachment_kind TEXT NOT NULL CHECK (
        attachment_kind IN ('embedded', 'external', 'delegated')
    ),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    status TEXT NOT NULL CHECK (
        status IN ('active', 'detached', 'revoked')
    ),
    attached_at TEXT NOT NULL,
    detached_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX idx_wallet_attachments_active_unique
    ON wallet_attachments(user_id, chain_namespace, wallet_address_normalized)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_wallet_attachments_active_primary
    ON wallet_attachments(user_id)
    WHERE status = 'active' AND is_primary = 1;

CREATE INDEX idx_wallet_attachments_user_namespace
    ON wallet_attachments(user_id, chain_namespace);

CREATE TABLE auth_provider_links (
    auth_provider_link_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    provider_user_ref TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'revoked')
    ),
    linked_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX idx_auth_provider_links_active_subject
    ON auth_provider_links(provider, provider_subject)
    WHERE status = 'active';

CREATE INDEX idx_auth_provider_links_user_provider
    ON auth_provider_links(user_id, provider);

CREATE TABLE verification_sessions (
    verification_session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    session_kind TEXT NOT NULL,
    requested_capabilities_json TEXT NOT NULL,
    verification_requirements_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'verified', 'failed', 'expired', 'canceled')
    ),
    upstream_session_ref TEXT,
    result_ref TEXT,
    failure_code TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_verification_sessions_user_status
    ON verification_sessions(user_id, status);

CREATE INDEX idx_verification_sessions_provider_ref
    ON verification_sessions(provider, upstream_session_ref);

CREATE TABLE user_attestations (
    user_attestation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_verification_session_id TEXT,
    provider TEXT NOT NULL,
    attestation_type TEXT NOT NULL,
    capability_key TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('accepted', 'expired', 'revoked', 'superseded')
    ),
    value_json TEXT NOT NULL,
    verified_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (source_verification_session_id) REFERENCES verification_sessions(verification_session_id)
);

CREATE INDEX idx_user_attestations_user_provider_type
    ON user_attestations(user_id, provider, attestation_type);

CREATE INDEX idx_user_attestations_user_capability_status
    ON user_attestations(user_id, capability_key, status);

CREATE TABLE global_handles (
    global_handle_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'redirect', 'retired')
    ),
    tier TEXT NOT NULL CHECK (
        tier IN ('generated', 'standard', 'premium')
    ),
    issuance_source TEXT NOT NULL CHECK (
        issuance_source IN ('generated_signup', 'free_cleanup_rename', 'reddit_verified_claim', 'paid_upgrade', 'admin_grant')
    ),
    redirect_target_global_handle_id TEXT,
    price_paid_usd REAL,
    free_rename_consumed INTEGER NOT NULL DEFAULT 0 CHECK (free_rename_consumed IN (0, 1)),
    issued_at TEXT NOT NULL,
    replaced_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (redirect_target_global_handle_id) REFERENCES global_handles(global_handle_id)
);

CREATE UNIQUE INDEX idx_global_handles_active_label
    ON global_handles(label_normalized)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_global_handles_active_user
    ON global_handles(user_id)
    WHERE status = 'active';

CREATE TABLE linked_handles (
    linked_handle_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    wallet_attachment_id TEXT,
    kind TEXT NOT NULL CHECK (
        kind IN ('pirate', 'ens')
    ),
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    verification_state TEXT NOT NULL CHECK (
        verification_state IN ('verified', 'unverified', 'stale')
    ),
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (wallet_attachment_id) REFERENCES wallet_attachments(wallet_attachment_id)
);

CREATE UNIQUE INDEX idx_linked_handles_user_kind_label
    ON linked_handles(user_id, kind, label_normalized);

CREATE UNIQUE INDEX idx_linked_handles_wallet_kind
    ON linked_handles(wallet_attachment_id, kind)
    WHERE wallet_attachment_id IS NOT NULL;

CREATE TABLE profiles (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    bio TEXT,
    bio_source TEXT CHECK (bio_source IS NULL OR bio_source IN ('ens', 'manual', 'none')),
    avatar_ref TEXT,
    avatar_source TEXT CHECK (avatar_source IS NULL OR avatar_source IN ('ens', 'upload', 'none')),
    cover_ref TEXT,
    cover_source TEXT CHECK (cover_source IS NULL OR cover_source IN ('ens', 'upload', 'none')),
    global_handle_id TEXT,
    primary_linked_handle_id TEXT,
    display_verified_nationality_badge INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (global_handle_id) REFERENCES global_handles(global_handle_id),
    FOREIGN KEY (primary_linked_handle_id) REFERENCES linked_handles(linked_handle_id)
);

ALTER TABLE users
    ADD CONSTRAINT fk_users_primary_wallet_attachment
    FOREIGN KEY (primary_wallet_attachment_id) REFERENCES wallet_attachments(wallet_attachment_id);

ALTER TABLE users
    ADD CONSTRAINT fk_users_current_verification_session
    FOREIGN KEY (current_verification_session_id) REFERENCES verification_sessions(verification_session_id);
