-- Fresh Postgres baseline for the control plane.

CREATE TABLE users (
    user_id TEXT PRIMARY KEY,
    primary_wallet_attachment_id TEXT,
    verification_state TEXT NOT NULL CHECK (
        verification_state IN ('unverified', 'pending', 'verified', 'reverification_required')
    ),
    capability_provider TEXT CHECK (
        capability_provider IS NULL OR capability_provider IN ('self', 'very', 'passport', 'zkpass')
    ),
    verification_capabilities_json JSONB NOT NULL,
    verified_at TIMESTAMPTZ,
    current_verification_session_id TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
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
    attached_at TIMESTAMPTZ NOT NULL,
    detached_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
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
    linked_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
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
    requested_capabilities_json JSONB NOT NULL,
    verification_requirements_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'verified', 'failed', 'expired', 'canceled')
    ),
    upstream_session_ref TEXT,
    result_ref TEXT,
    failure_code TEXT,
    wallet_attachment_id TEXT,
    verification_intent TEXT,
    policy_id TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
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
    value_json JSONB NOT NULL,
    verified_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
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
    issued_at TIMESTAMPTZ NOT NULL,
    replaced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
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
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
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
    preferred_locale TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (global_handle_id) REFERENCES global_handles(global_handle_id),
    FOREIGN KEY (primary_linked_handle_id) REFERENCES linked_handles(linked_handle_id)
);

CREATE TABLE communities (
    community_id TEXT PRIMARY KEY,
    creator_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    membership_mode TEXT NOT NULL CHECK (
        membership_mode IN ('open', 'request', 'gated')
    ),
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
    pending_namespace_verification_session_id TEXT,
    primary_database_binding_id TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (creator_user_id) REFERENCES users(user_id)
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
    requires_credentials INTEGER NOT NULL DEFAULT 1 CHECK (requires_credentials IN (0, 1)),
    status TEXT NOT NULL CHECK (
        status IN ('active', 'inactive', 'pending_transfer', 'superseded', 'error')
    ),
    transferred_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
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
    issued_at TIMESTAMPTZ NOT NULL,
    invalidated_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
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
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (
        visibility IN ('public', 'members_only')
    ),
    upvote_count INTEGER NOT NULL DEFAULT 0,
    downvote_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    like_count INTEGER NOT NULL DEFAULT 0,
    source_created_at TIMESTAMPTZ NOT NULL,
    projected_payload_json JSONB NOT NULL,
    projection_version INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_post_projections_club_created
    ON community_post_projections(community_id, source_created_at DESC);

CREATE INDEX idx_community_post_projections_status_created
    ON community_post_projections(status, source_created_at DESC);

CREATE INDEX idx_community_post_projections_published_score_created
    ON community_post_projections(
        status,
        community_id,
        (upvote_count - downvote_count) DESC,
        source_created_at DESC,
        source_post_id DESC
    );

CREATE UNIQUE INDEX idx_community_post_projections_source_version
    ON community_post_projections(community_id, source_post_id, projection_version);

CREATE TABLE comment_projections (
    projection_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    thread_root_post_id TEXT NOT NULL,
    source_comment_id TEXT NOT NULL,
    parent_comment_id TEXT,
    depth INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('published', 'hidden', 'removed', 'deleted')
    ),
    source_created_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX idx_comment_projections_source_comment
    ON comment_projections(community_id, source_comment_id);

CREATE INDEX idx_comment_projections_thread_created
    ON comment_projections(thread_root_post_id, source_created_at DESC);

CREATE INDEX idx_comment_projections_comment_id
    ON comment_projections(source_comment_id);

CREATE TABLE community_membership_projections (
    projection_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    membership_state TEXT NOT NULL CHECK (
        membership_state IN ('not_member', 'pending_request', 'member', 'banned')
    ),
    role_summary_json JSONB,
    source_updated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX idx_community_membership_projections_unique
    ON community_membership_projections(community_id, user_id);

CREATE INDEX idx_community_membership_projections_user_state
    ON community_membership_projections(user_id, membership_state);

CREATE TABLE scrobble_ingest_events (
    scrobble_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    community_id TEXT,
    source_type TEXT NOT NULL,
    playback_started_at TIMESTAMPTZ NOT NULL,
    playback_position_ms INTEGER,
    credited_duration_ms INTEGER,
    ingestion_mode TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    anchor_status TEXT NOT NULL DEFAULT 'queued' CHECK (
        anchor_status IN (
            'queued',
            'awaiting_wallet',
            'awaiting_track',
            'anchoring',
            'anchored',
            'failed',
            'suppressed'
        )
    ),
    anchor_attempt_count INTEGER NOT NULL DEFAULT 0,
    wallet_attachment_id TEXT,
    accepted_at TIMESTAMPTZ NOT NULL,
    anchored_at TIMESTAMPTZ,
    chain_tx_hash TEXT,
    chain_log_index INTEGER,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (wallet_attachment_id) REFERENCES wallet_attachments(wallet_attachment_id)
);

CREATE UNIQUE INDEX idx_scrobble_idempotency
    ON scrobble_ingest_events(user_id, idempotency_key);

CREATE INDEX idx_scrobble_anchor_status
    ON scrobble_ingest_events(anchor_status, accepted_at);

CREATE INDEX idx_scrobble_user_status
    ON scrobble_ingest_events(user_id, anchor_status);

CREATE INDEX idx_scrobble_wallet_anchor
    ON scrobble_ingest_events(wallet_attachment_id, anchor_status)
    WHERE anchor_status IN ('queued', 'awaiting_track', 'awaiting_wallet');

CREATE TABLE scrobble_anchor_batches (
    batch_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'submitting', 'confirmed', 'failed')
    ),
    publisher_kind TEXT NOT NULL CHECK (
        publisher_kind IN ('direct-key', 'pkp')
    ),
    chain_id INTEGER NOT NULL DEFAULT 1315,
    wallet_address TEXT NOT NULL,
    tx_hash TEXT,
    error_code TEXT,
    item_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    confirmed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_scrobble_anchor_batches_status
    ON scrobble_anchor_batches(status, created_at);

CREATE TABLE scrobble_anchor_batch_items (
    batch_id TEXT NOT NULL,
    scrobble_id TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    event_log_index INTEGER,
    PRIMARY KEY (batch_id, scrobble_id),
    FOREIGN KEY (batch_id) REFERENCES scrobble_anchor_batches(batch_id),
    FOREIGN KEY (scrobble_id) REFERENCES scrobble_ingest_events(scrobble_id)
);

CREATE INDEX idx_scrobble_anchor_batch_items_scrobble
    ON scrobble_anchor_batch_items(scrobble_id);

CREATE TABLE track_anchor_state (
    track_id TEXT PRIMARY KEY,
    metadata_hash TEXT NOT NULL,
    registration_status TEXT NOT NULL DEFAULT 'not_registered' CHECK (
        registration_status IN ('not_registered', 'registering', 'registered')
    ),
    registered_tx_hash TEXT,
    registered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_track_anchor_state_not_registered
    ON track_anchor_state(registration_status)
    WHERE registration_status = 'not_registered';

CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    job_scope TEXT NOT NULL CHECK (
        job_scope IN ('platform', 'community')
    ),
    community_id TEXT,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'succeeded', 'failed')
    ),
    payload_json JSONB,
    result_ref TEXT,
    error_code TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_jobs_status_available
    ON jobs(status, available_at);

CREATE INDEX idx_jobs_subject
    ON jobs(subject_type, subject_id);

CREATE INDEX idx_jobs_club_status
    ON jobs(community_id, status);

CREATE TABLE audit_log (
    audit_event_id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL CHECK (
        actor_type IN ('user', 'worker', 'system', 'operator')
    ),
    actor_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    community_id TEXT,
    metadata_json JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_audit_log_actor
    ON audit_log(actor_id, created_at DESC);

CREATE INDEX idx_audit_log_target
    ON audit_log(target_type, target_id, created_at DESC);

CREATE INDEX idx_audit_log_club
    ON audit_log(community_id, created_at DESC);

CREATE TABLE namespace_verification_sessions (
    namespace_verification_session_id TEXT PRIMARY KEY,
    namespace_verification_id TEXT,
    user_id TEXT NOT NULL,
    family TEXT NOT NULL CHECK (
        family IN ('hns', 'spaces')
    ),
    submitted_root_label TEXT NOT NULL,
    normalized_root_label TEXT,
    status TEXT NOT NULL CHECK (
        status IN (
            'draft',
            'inspecting',
            'challenge_required',
            'challenge_pending',
            'verifying',
            'verified',
            'failed',
            'expired',
            'disputed'
        )
    ),
    challenge_host TEXT,
    challenge_txt_value TEXT,
    setup_nameservers_json JSONB,
    challenge_kind TEXT CHECK (
        challenge_kind IS NULL OR challenge_kind IN ('dns_txt', 'fabric_txt_publish')
    ),
    challenge_payload_json JSONB,
    challenge_expires_at TIMESTAMPTZ,
    root_exists INTEGER CHECK (root_exists IS NULL OR root_exists IN (0, 1)),
    root_control_verified INTEGER CHECK (root_control_verified IS NULL OR root_control_verified IN (0, 1)),
    expiry_horizon_sufficient INTEGER CHECK (expiry_horizon_sufficient IS NULL OR expiry_horizon_sufficient IN (0, 1)),
    routing_enabled INTEGER CHECK (routing_enabled IS NULL OR routing_enabled IN (0, 1)),
    pirate_dns_authority_verified INTEGER CHECK (pirate_dns_authority_verified IS NULL OR pirate_dns_authority_verified IN (0, 1)),
    club_attach_allowed INTEGER CHECK (club_attach_allowed IS NULL OR club_attach_allowed IN (0, 1)),
    pirate_web_routing_allowed INTEGER CHECK (pirate_web_routing_allowed IS NULL OR pirate_web_routing_allowed IN (0, 1)),
    pirate_subdomain_issuance_allowed INTEGER CHECK (pirate_subdomain_issuance_allowed IS NULL OR pirate_subdomain_issuance_allowed IN (0, 1)),
    control_class TEXT CHECK (
        control_class IS NULL OR control_class IN (
            'single_holder_root',
            'multisig_controlled_root',
            'dao_controlled_root',
            'burned_or_immutable_root'
        )
    ),
    operation_class TEXT CHECK (
        operation_class IS NULL OR operation_class IN (
            'owner_managed_namespace',
            'routing_only_namespace',
            'pirate_delegated_namespace',
            'owner_signed_updates_namespace'
        )
    ),
    anchor_height BIGINT,
    anchor_block_hash TEXT,
    anchor_root_hash TEXT,
    proof_root_hash TEXT,
    observation_provider TEXT,
    evidence_bundle_ref TEXT,
    failure_reason TEXT,
    accepted_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX idx_namespace_verification_sessions_verification_id
    ON namespace_verification_sessions(namespace_verification_id)
    WHERE namespace_verification_id IS NOT NULL;

CREATE INDEX idx_namespace_verification_sessions_user_status
    ON namespace_verification_sessions(user_id, status);

CREATE INDEX idx_namespace_verification_sessions_root_status
    ON namespace_verification_sessions(normalized_root_label, status);

CREATE TABLE namespace_verifications (
    namespace_verification_id TEXT PRIMARY KEY,
    source_namespace_verification_session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    family TEXT NOT NULL CHECK (
        family IN ('hns', 'spaces')
    ),
    normalized_root_label TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('verified', 'stale', 'expired', 'disputed')
    ),
    root_exists INTEGER NOT NULL CHECK (root_exists IN (0, 1)),
    root_control_verified INTEGER CHECK (root_control_verified IS NULL OR root_control_verified IN (0, 1)),
    expiry_horizon_sufficient INTEGER CHECK (expiry_horizon_sufficient IS NULL OR expiry_horizon_sufficient IN (0, 1)),
    routing_enabled INTEGER CHECK (routing_enabled IS NULL OR routing_enabled IN (0, 1)),
    pirate_dns_authority_verified INTEGER CHECK (pirate_dns_authority_verified IS NULL OR pirate_dns_authority_verified IN (0, 1)),
    club_attach_allowed INTEGER NOT NULL CHECK (club_attach_allowed IN (0, 1)),
    pirate_web_routing_allowed INTEGER CHECK (pirate_web_routing_allowed IS NULL OR pirate_web_routing_allowed IN (0, 1)),
    pirate_subdomain_issuance_allowed INTEGER CHECK (pirate_subdomain_issuance_allowed IS NULL OR pirate_subdomain_issuance_allowed IN (0, 1)),
    control_class TEXT CHECK (
        control_class IS NULL OR control_class IN (
            'single_holder_root',
            'multisig_controlled_root',
            'dao_controlled_root',
            'burned_or_immutable_root'
        )
    ),
    operation_class TEXT CHECK (
        operation_class IS NULL OR operation_class IN (
            'owner_managed_namespace',
            'routing_only_namespace',
            'pirate_delegated_namespace',
            'owner_signed_updates_namespace'
        )
    ),
    anchor_height BIGINT,
    anchor_block_hash TEXT,
    anchor_root_hash TEXT,
    proof_root_hash TEXT,
    observation_provider TEXT,
    evidence_bundle_ref TEXT,
    accepted_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (source_namespace_verification_session_id) REFERENCES namespace_verification_sessions(namespace_verification_session_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX idx_namespace_verifications_source_session
    ON namespace_verifications(source_namespace_verification_session_id);

CREATE INDEX idx_namespace_verifications_user_status
    ON namespace_verifications(user_id, status);

CREATE INDEX idx_namespace_verifications_root_status
    ON namespace_verifications(normalized_root_label, status);

CREATE TABLE namespace_verification_evidence_bundles (
    evidence_bundle_id TEXT PRIMARY KEY,
    namespace_verification_session_id TEXT NOT NULL,
    namespace_verification_id TEXT,
    family TEXT NOT NULL CHECK (
        family IN ('hns', 'spaces')
    ),
    normalized_root_label TEXT,
    evidence_kind TEXT NOT NULL CHECK (
        evidence_kind IN (
            'inspection_snapshot',
            'txt_observation',
            'delegation_snapshot',
            'anchor_snapshot',
            'space_proof_snapshot',
            'fabric_publish',
            'accepted_snapshot',
            'revalidation_snapshot'
        )
    ),
    provider TEXT,
    resolver_path_json JSONB,
    raw_response_json JSONB,
    evidence_hash TEXT,
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (namespace_verification_session_id) REFERENCES namespace_verification_sessions(namespace_verification_session_id),
    FOREIGN KEY (namespace_verification_id) REFERENCES namespace_verifications(namespace_verification_id)
);

CREATE INDEX idx_namespace_verification_evidence_session
    ON namespace_verification_evidence_bundles(namespace_verification_session_id, observed_at DESC);

CREATE INDEX idx_namespace_verification_evidence_verification
    ON namespace_verification_evidence_bundles(namespace_verification_id, observed_at DESC);

CREATE TABLE namespace_verification_assertions (
    assertion_record_id TEXT PRIMARY KEY,
    namespace_verification_session_id TEXT NOT NULL,
    namespace_verification_id TEXT,
    family TEXT NOT NULL CHECK (
        family IN ('hns', 'spaces')
    ),
    assertion_name TEXT NOT NULL CHECK (
        assertion_name IN (
            'root_exists',
            'root_control_verified',
            'expiry_horizon_sufficient',
            'routing_enabled',
            'pirate_dns_authority_verified',
            'root_key_proof_verified',
            'fabric_publish_verified',
            'anchor_fresh_enough',
            'owner_signed_updates_verified'
        )
    ),
    assertion_value INTEGER CHECK (assertion_value IS NULL OR assertion_value IN (0, 1)),
    source_evidence_bundle_id TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('accepted', 'stale', 'disputed', 'superseded')
    ),
    first_accepted_at TIMESTAMPTZ,
    last_revalidated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (namespace_verification_session_id) REFERENCES namespace_verification_sessions(namespace_verification_session_id),
    FOREIGN KEY (namespace_verification_id) REFERENCES namespace_verifications(namespace_verification_id),
    FOREIGN KEY (source_evidence_bundle_id) REFERENCES namespace_verification_evidence_bundles(evidence_bundle_id)
);

CREATE INDEX idx_namespace_verification_assertions_session
    ON namespace_verification_assertions(namespace_verification_session_id, assertion_name);

CREATE INDEX idx_namespace_verification_assertions_verification
    ON namespace_verification_assertions(namespace_verification_id, assertion_name, status);

CREATE INDEX idx_communities_namespace_verification
    ON communities(namespace_verification_id)
    WHERE namespace_verification_id IS NOT NULL;

CREATE TABLE community_registry_attempts (
    registry_attempt_id TEXT PRIMARY KEY,
    actor_user_id TEXT NOT NULL,
    actor_primary_wallet_snapshot TEXT,
    actor_governance_address_snapshot TEXT,
    namespace_verification_id TEXT NOT NULL,
    normalized_root_label TEXT NOT NULL,
    community_id TEXT,
    attempt_status TEXT NOT NULL CHECK (
        attempt_status IN ('in_progress', 'succeeded', 'failed')
    ),
    failure_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (actor_user_id) REFERENCES users(user_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_verification_id) REFERENCES namespace_verifications(namespace_verification_id)
);

CREATE INDEX idx_community_registry_attempts_actor
    ON community_registry_attempts(actor_user_id, created_at DESC);

CREATE INDEX idx_community_registry_attempts_wallet
    ON community_registry_attempts(actor_primary_wallet_snapshot, created_at DESC)
    WHERE actor_primary_wallet_snapshot IS NOT NULL;

CREATE INDEX idx_community_registry_attempts_namespace
    ON community_registry_attempts(namespace_verification_id, created_at DESC);

CREATE INDEX idx_community_registry_attempts_community
    ON community_registry_attempts(community_id, created_at DESC)
    WHERE community_id IS NOT NULL;

CREATE TABLE reddit_verification_sessions (
    reddit_verification_session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    reddit_username TEXT NOT NULL,
    verification_code TEXT NOT NULL,
    code_placement_surface TEXT NOT NULL CHECK (
        code_placement_surface IN ('profile', 'bio', 'about')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'verified', 'failed', 'expired')
    ),
    verification_hint TEXT,
    failure_code TEXT CHECK (
        failure_code IS NULL OR failure_code IN ('code_not_found', 'username_not_found', 'rate_limited', 'source_error')
    ),
    checked_count INTEGER NOT NULL DEFAULT 0,
    last_checked_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_reddit_verification_sessions_user_created
    ON reddit_verification_sessions(user_id, created_at DESC);

CREATE INDEX idx_reddit_verification_sessions_user_username_created
    ON reddit_verification_sessions(user_id, reddit_username, created_at DESC);

CREATE TABLE external_reputation_snapshots (
    external_reputation_snapshot_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_platform TEXT NOT NULL CHECK (
        source_platform IN ('reddit')
    ),
    snapshot_type TEXT NOT NULL CHECK (
        snapshot_type IN ('onboarding')
    ),
    source_account_handle TEXT NOT NULL,
    proof_method TEXT NOT NULL CHECK (
        proof_method IN ('profile_code')
    ),
    captured_at TIMESTAMPTZ NOT NULL,
    snapshot_payload_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_external_reputation_snapshots_user_source_created
    ON external_reputation_snapshots(user_id, source_platform, created_at DESC);

CREATE TABLE community_money_policies (
    community_id TEXT PRIMARY KEY,
    funding_preference TEXT NOT NULL,
    accepted_funding_assets_json JSONB NOT NULL,
    accepted_source_chains_json JSONB NOT NULL,
    approved_route_providers_json JSONB,
    destination_settlement_chain_json JSONB NOT NULL,
    destination_settlement_token TEXT NOT NULL,
    treasury_denomination TEXT,
    max_slippage_bps INTEGER NOT NULL CHECK (
        max_slippage_bps >= 0
    ),
    quote_ttl_seconds INTEGER NOT NULL CHECK (
        quote_ttl_seconds >= 1
    ),
    route_required INTEGER NOT NULL CHECK (
        route_required IN (0, 1)
    ),
    route_status_policy TEXT NOT NULL CHECK (
        route_status_policy IN ('fail', 'fallback_display', 'queue')
    ),
    route_hop_tolerance INTEGER NOT NULL CHECK (
        route_hop_tolerance >= 0
    ),
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_money_policies_route_required
    ON community_money_policies(route_required, updated_at DESC);

CREATE TABLE song_artifact_bundles (
    song_artifact_bundle_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    creator_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'validating', 'ready', 'consuming', 'consumed', 'failed')
    ),
    primary_audio_json JSONB NOT NULL,
    lyrics_text TEXT NOT NULL,
    lyrics_sha256 TEXT NOT NULL,
    cover_art_json JSONB,
    preview_audio_json JSONB,
    canvas_video_json JSONB,
    instrumental_audio_json JSONB,
    vocal_audio_json JSONB,
    translation_status TEXT,
    translation_error TEXT,
    translated_lyrics_ref TEXT,
    translated_lyrics_json JSONB,
    alignment_status TEXT,
    alignment_error TEXT,
    timed_lyrics_ref TEXT,
    timed_lyrics_json JSONB,
    moderation_status TEXT,
    moderation_error TEXT,
    moderation_result_ref TEXT,
    moderation_result_json JSONB,
    preview_window_json JSONB,
    preview_status TEXT NOT NULL DEFAULT 'completed',
    preview_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (creator_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_song_artifact_bundles_community_created
    ON song_artifact_bundles(community_id, created_at DESC);

CREATE INDEX idx_song_artifact_bundles_creator_created
    ON song_artifact_bundles(creator_user_id, created_at DESC);

CREATE INDEX idx_song_artifact_bundles_translation_status
    ON song_artifact_bundles(translation_status, created_at DESC);

CREATE INDEX idx_song_artifact_bundles_alignment_status
    ON song_artifact_bundles(alignment_status, created_at DESC);

CREATE INDEX idx_song_artifact_bundles_moderation_status
    ON song_artifact_bundles(moderation_status, created_at DESC);

CREATE TABLE song_artifact_uploads (
    song_artifact_upload_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    uploader_user_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL CHECK (
        artifact_kind IN ('primary_audio', 'cover_art', 'preview_audio', 'canvas_video', 'instrumental_audio', 'vocal_audio')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('pending_upload', 'uploaded', 'failed')
    ),
    storage_ref TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    filename TEXT,
    size_bytes INTEGER,
    content_hash TEXT,
    blob_path TEXT,
    storage_provider TEXT,
    storage_bucket TEXT,
    storage_object_key TEXT,
    storage_endpoint TEXT,
    gateway_url TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (uploader_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_song_artifact_uploads_community_created
    ON song_artifact_uploads(community_id, created_at DESC);

CREATE INDEX idx_song_artifact_uploads_uploader_created
    ON song_artifact_uploads(uploader_user_id, created_at DESC);

CREATE TABLE community_pricing_policies (
    community_id TEXT PRIMARY KEY,
    regional_pricing_enabled INTEGER NOT NULL CHECK (
        regional_pricing_enabled IN (0, 1)
    ),
    verification_provider_requirement TEXT CHECK (
        verification_provider_requirement IS NULL OR verification_provider_requirement IN ('self')
    ),
    default_tier_key TEXT,
    tiers_json JSONB NOT NULL,
    country_assignments_json JSONB NOT NULL,
    source_template_id TEXT,
    source_template_version TEXT,
    pricing_policy_version TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_pricing_policies_enabled
    ON community_pricing_policies(regional_pricing_enabled, updated_at DESC);

CREATE TABLE community_registry_table_refs (
    community_id TEXT PRIMARY KEY,
    registry_chain_id INTEGER NOT NULL,
    attempts_table_name TEXT NOT NULL,
    club_registry_table_name TEXT,
    club_namespace_table_name TEXT,
    publisher_kind TEXT NOT NULL CHECK (
        publisher_kind IN ('direct_key')
    ),
    last_published_snapshot_hash TEXT,
    last_publish_attempted_at TIMESTAMPTZ,
    last_publish_succeeded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_registry_table_refs_registry_table
    ON community_registry_table_refs(club_registry_table_name)
    WHERE club_registry_table_name IS NOT NULL;

CREATE INDEX idx_community_registry_table_refs_namespace_table
    ON community_registry_table_refs(club_namespace_table_name)
    WHERE club_namespace_table_name IS NOT NULL;

CREATE TABLE community_gate_rules (
    gate_rule_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (
        scope IN ('membership', 'viewer', 'posting')
    ),
    gate_family TEXT NOT NULL CHECK (
        gate_family IN ('identity_proof', 'token_holding')
    ),
    gate_type TEXT NOT NULL,
    proof_requirements_json JSONB,
    chain_namespace TEXT,
    gate_config_json JSONB,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'disabled')
    ),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_gate_rules_community_scope_status
    ON community_gate_rules(community_id, scope, status, created_at DESC);

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

CREATE UNIQUE INDEX idx_sentinel_subscriptions_chain_subscription_id
    ON sentinel_subscriptions(chain_subscription_id);

CREATE UNIQUE INDEX idx_sentinel_subscriptions_active_user
    ON sentinel_subscriptions(user_id)
    WHERE status = 'active';

CREATE TABLE sentinel_sessions (
    sentinel_session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    sentinel_subscription_id TEXT NOT NULL,
    wallet_attachment_id TEXT NOT NULL,
    chain_session_id TEXT NOT NULL,
    node_address TEXT NOT NULL,
    transport_kind TEXT NOT NULL CHECK (
        transport_kind IN ('wireguard')
    ),
    connection_payload_json JSONB NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('starting', 'active', 'ended', 'failed')
    ),
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    start_idempotency_key TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (sentinel_subscription_id) REFERENCES sentinel_subscriptions(sentinel_subscription_id),
    FOREIGN KEY (wallet_attachment_id) REFERENCES wallet_attachments(wallet_attachment_id)
);

CREATE INDEX idx_sentinel_sessions_user_status
    ON sentinel_sessions(user_id, status, started_at DESC);

CREATE UNIQUE INDEX idx_sentinel_sessions_chain_session_id
    ON sentinel_sessions(chain_session_id);

CREATE UNIQUE INDEX idx_sentinel_sessions_active_user
    ON sentinel_sessions(user_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_sentinel_sessions_user_start_idempotency
    ON sentinel_sessions(user_id, start_idempotency_key)
    WHERE start_idempotency_key IS NOT NULL;

CREATE TABLE community_registry_mutation_attempts (
    registry_mutation_attempt_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    mutation_kind TEXT NOT NULL CHECK (
        mutation_kind IN (
            'profile',
            'rules',
            'resource_links',
            'reference_links',
            'governance',
            'donation_public',
            'handle_policy_summary',
            'livestream_public'
        )
    ),
    publisher_attempt_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_primary_wallet_snapshot TEXT,
    actor_governance_address_snapshot TEXT,
    attempt_status TEXT NOT NULL CHECK (
        attempt_status IN ('in_progress', 'succeeded', 'failed')
    ),
    failure_code TEXT,
    attempts_table_name TEXT,
    dataset_table_name TEXT,
    secondary_table_name TEXT,
    snapshot_hash TEXT NOT NULL,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (actor_user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX idx_community_registry_mutation_attempts_publisher_attempt
    ON community_registry_mutation_attempts(publisher_attempt_id);

CREATE INDEX idx_community_registry_mutation_attempts_current
    ON community_registry_mutation_attempts(community_id, mutation_kind, published_at DESC)
    WHERE attempt_status = 'succeeded';

CREATE INDEX idx_community_registry_mutation_attempts_actor
    ON community_registry_mutation_attempts(actor_user_id, created_at DESC);

CREATE INDEX idx_community_registry_mutation_attempts_community
    ON community_registry_mutation_attempts(community_id, created_at DESC);

CREATE TABLE namespace_verification_capabilities (
    capability_record_id TEXT PRIMARY KEY,
    namespace_verification_session_id TEXT NOT NULL,
    namespace_verification_id TEXT,
    family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
    capability_name TEXT NOT NULL CHECK (
        capability_name IN (
            'club_attach_allowed',
            'pirate_web_routing_allowed',
            'pirate_subdomain_issuance_allowed',
            'owner_signed_record_updates_allowed',
            'pirate_subspace_issuance_allowed'
        )
    ),
    capability_value INTEGER CHECK (capability_value IS NULL OR capability_value IN (0, 1)),
    source_evidence_bundle_id TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('accepted', 'stale', 'disputed', 'superseded')
    ),
    first_accepted_at TIMESTAMPTZ,
    last_revalidated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (namespace_verification_session_id) REFERENCES namespace_verification_sessions(namespace_verification_session_id),
    FOREIGN KEY (namespace_verification_id) REFERENCES namespace_verifications(namespace_verification_id),
    FOREIGN KEY (source_evidence_bundle_id) REFERENCES namespace_verification_evidence_bundles(evidence_bundle_id)
);

CREATE INDEX idx_namespace_verification_capabilities_session
    ON namespace_verification_capabilities(namespace_verification_session_id, capability_name, status);

CREATE INDEX idx_namespace_verification_capabilities_verification
    ON namespace_verification_capabilities(namespace_verification_id, capability_name, status);

CREATE UNIQUE INDEX idx_namespace_verification_capabilities_session_name_status_unique
    ON namespace_verification_capabilities(namespace_verification_session_id, capability_name, status);

CREATE UNIQUE INDEX idx_namespace_verification_capabilities_verification_name_status_unique
    ON namespace_verification_capabilities(namespace_verification_id, capability_name, status)
    WHERE namespace_verification_id IS NOT NULL;

ALTER TABLE users
    ADD CONSTRAINT fk_users_primary_wallet_attachment
    FOREIGN KEY (primary_wallet_attachment_id) REFERENCES wallet_attachments(wallet_attachment_id);

ALTER TABLE users
    ADD CONSTRAINT fk_users_current_verification_session
    FOREIGN KEY (current_verification_session_id) REFERENCES verification_sessions(verification_session_id);

ALTER TABLE communities
    ADD CONSTRAINT fk_communities_primary_database_binding
    FOREIGN KEY (primary_database_binding_id) REFERENCES community_database_bindings(community_database_binding_id);

ALTER TABLE communities
    ADD CONSTRAINT fk_communities_namespace_verification
    FOREIGN KEY (namespace_verification_id)
    REFERENCES namespace_verifications(namespace_verification_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX idx_communities_namespace_verification_unique
    ON communities(namespace_verification_id)
    WHERE namespace_verification_id IS NOT NULL;

CREATE TABLE user_agents (
    agent_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'active', 'suspended', 'revoked', 'transferred', 'deregistered')
    ),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_user_agents_owner
    ON user_agents(owner_user_id, created_at DESC);

CREATE TABLE agent_handles (
    agent_handle_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'redirect', 'retired')
    ),
    redirect_target_agent_handle_id TEXT,
    issued_at TIMESTAMPTZ NOT NULL,
    replaced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES user_agents(agent_id),
    FOREIGN KEY (redirect_target_agent_handle_id) REFERENCES agent_handles(agent_handle_id)
);

CREATE UNIQUE INDEX idx_agent_handles_active_label
    ON agent_handles(label_normalized)
    WHERE status = 'active';

CREATE UNIQUE INDEX idx_agent_handles_active_agent
    ON agent_handles(agent_id)
    WHERE status = 'active';

CREATE TABLE agent_ownership_records (
    agent_ownership_record_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    ownership_provider TEXT NOT NULL CHECK (
        ownership_provider IN ('self_agent_id', 'clawkey')
    ),
    provider_subject_id TEXT,
    device_id TEXT,
    public_key TEXT,
    ownership_state TEXT NOT NULL CHECK (
        ownership_state IN ('pending', 'verified', 'expired', 'revoked', 'transferred')
    ),
    source_session_id TEXT,
    verified_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    evidence_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES user_agents(agent_id),
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_agent_ownership_records_owner
    ON agent_ownership_records(owner_user_id, created_at DESC);

CREATE INDEX idx_agent_ownership_records_agent
    ON agent_ownership_records(agent_id, created_at DESC);

CREATE UNIQUE INDEX idx_agent_ownership_records_active_verified_unique
    ON agent_ownership_records(agent_id)
    WHERE ownership_state = 'verified' AND ended_at IS NULL;

CREATE TABLE agent_ownership_sessions (
    agent_ownership_session_id TEXT PRIMARY KEY,
    session_kind TEXT NOT NULL CHECK (
        session_kind IN ('register', 'refresh', 'transfer', 'deregister')
    ),
    owner_user_id TEXT,
    agent_id TEXT,
    display_name TEXT,
    policy_id TEXT,
    ownership_provider TEXT NOT NULL CHECK (
        ownership_provider IN ('self_agent_id', 'clawkey')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'awaiting_owner', 'proof_submitted', 'verified', 'failed', 'expired', 'cancelled')
    ),
    agent_challenge_ref TEXT NOT NULL,
    agent_challenge_payload_json JSONB NOT NULL,
    provider_session_ref TEXT,
    launch_json JSONB NOT NULL,
    callback_path TEXT,
    resolved_agent_ownership_record_id TEXT,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_agent_ownership_sessions_owner
    ON agent_ownership_sessions(owner_user_id, created_at DESC);

CREATE INDEX idx_agent_ownership_sessions_agent
    ON agent_ownership_sessions(agent_id, created_at DESC);

CREATE INDEX idx_agent_ownership_sessions_provider_status
  ON agent_ownership_sessions(ownership_provider, status, created_at DESC);

CREATE TABLE agent_pairing_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'claimed', 'completed', 'expired')
  ),
  claimed_at TIMESTAMPTZ,
  connection_token_hash TEXT UNIQUE,
  agent_ownership_session_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (agent_ownership_session_id) REFERENCES agent_ownership_sessions(agent_ownership_session_id)
);

CREATE INDEX idx_agent_pairing_codes_user
  ON agent_pairing_codes(user_id, created_at DESC);

CREATE INDEX idx_agent_pairing_codes_expires
  ON agent_pairing_codes(expires_at DESC);

CREATE UNIQUE INDEX idx_agent_pairing_codes_session_unique
  ON agent_pairing_codes(agent_ownership_session_id)
  WHERE agent_ownership_session_id IS NOT NULL;

CREATE TABLE agent_delegated_credentials (
  agent_delegated_credential_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    agent_ownership_record_id TEXT NOT NULL,
    access_token_hash TEXT NOT NULL UNIQUE,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'superseded', 'revoked', 'expired')
    ),
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    refresh_expires_at TIMESTAMPTZ,
    superseded_by_credential_id TEXT,
    refreshed_from_credential_id TEXT,
    invalidated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES user_agents(agent_id),
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id),
    FOREIGN KEY (agent_ownership_record_id) REFERENCES agent_ownership_records(agent_ownership_record_id)
);

CREATE INDEX idx_agent_delegated_credentials_owner
    ON agent_delegated_credentials(owner_user_id, created_at DESC);

CREATE INDEX idx_agent_delegated_credentials_agent
    ON agent_delegated_credentials(agent_id, created_at DESC);

CREATE TABLE agent_action_nonce_replays (
    agent_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    signed_at TIMESTAMPTZ NOT NULL,
    canonical_request_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (agent_id, nonce),
    FOREIGN KEY (agent_id) REFERENCES user_agents(agent_id)
);

CREATE INDEX idx_agent_action_nonce_replays_expires_at
    ON agent_action_nonce_replays(expires_at);
