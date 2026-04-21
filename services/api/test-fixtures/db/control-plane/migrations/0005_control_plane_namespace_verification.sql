PRAGMA foreign_keys = ON;

CREATE TABLE namespace_verification_sessions (
    namespace_verification_session_id TEXT PRIMARY KEY,
    namespace_verification_id TEXT,
    user_id TEXT NOT NULL,
    family TEXT NOT NULL CHECK (
        family IN ('hns')
    ),
    submitted_root_label TEXT NOT NULL,
    normalized_root_label TEXT,
    status TEXT NOT NULL CHECK (
        status IN (
            'draft',
            'inspecting',
            'dns_setup_required',
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
    challenge_expires_at TEXT,
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
    observation_provider TEXT,
    evidence_bundle_ref TEXT,
    failure_reason TEXT,
    accepted_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
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
        family IN ('hns')
    ),
    normalized_root_label TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('verified', 'stale', 'expired', 'disputed')
    ),
    root_exists INTEGER NOT NULL CHECK (root_exists IN (0, 1)),
    root_control_verified INTEGER NOT NULL CHECK (root_control_verified IN (0, 1)),
    expiry_horizon_sufficient INTEGER NOT NULL CHECK (expiry_horizon_sufficient IN (0, 1)),
    routing_enabled INTEGER NOT NULL CHECK (routing_enabled IN (0, 1)),
    pirate_dns_authority_verified INTEGER NOT NULL CHECK (pirate_dns_authority_verified IN (0, 1)),
    club_attach_allowed INTEGER NOT NULL CHECK (club_attach_allowed IN (0, 1)),
    pirate_web_routing_allowed INTEGER NOT NULL CHECK (pirate_web_routing_allowed IN (0, 1)),
    pirate_subdomain_issuance_allowed INTEGER NOT NULL CHECK (pirate_subdomain_issuance_allowed IN (0, 1)),
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
    observation_provider TEXT,
    evidence_bundle_ref TEXT,
    accepted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
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
        family IN ('hns')
    ),
    normalized_root_label TEXT,
    evidence_kind TEXT NOT NULL CHECK (
        evidence_kind IN (
            'inspection_snapshot',
            'txt_observation',
            'delegation_snapshot',
            'accepted_snapshot',
            'revalidation_snapshot'
        )
    ),
    provider TEXT,
    resolver_path_json TEXT,
    raw_response_json TEXT,
    evidence_hash TEXT,
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
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
    assertion_name TEXT NOT NULL CHECK (
        assertion_name IN (
            'root_exists',
            'root_control_verified',
            'expiry_horizon_sufficient',
            'routing_enabled',
            'pirate_dns_authority_verified'
        )
    ),
    assertion_value INTEGER CHECK (assertion_value IS NULL OR assertion_value IN (0, 1)),
    source_evidence_bundle_id TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('accepted', 'stale', 'disputed', 'superseded')
    ),
    first_accepted_at TEXT,
    last_revalidated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (namespace_verification_session_id) REFERENCES namespace_verification_sessions(namespace_verification_session_id),
    FOREIGN KEY (namespace_verification_id) REFERENCES namespace_verifications(namespace_verification_id),
    FOREIGN KEY (source_evidence_bundle_id) REFERENCES namespace_verification_evidence_bundles(evidence_bundle_id)
);

CREATE INDEX idx_namespace_verification_assertions_session
    ON namespace_verification_assertions(namespace_verification_session_id, assertion_name);

CREATE INDEX idx_namespace_verification_assertions_verification
    ON namespace_verification_assertions(namespace_verification_id, assertion_name, status);

CREATE TABLE namespace_verification_revalidation_events (
    revalidation_event_id TEXT PRIMARY KEY,
    namespace_verification_id TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (
        trigger IN (
            'manual_refresh',
            'scheduled_refresh',
            'create_time_recheck',
            'delegation_change',
            'expiry_change',
            'contradiction_detected'
        )
    ),
    old_assertions_json TEXT,
    new_assertions_json TEXT,
    old_capabilities_json TEXT,
    new_capabilities_json TEXT,
    old_status TEXT CHECK (
        old_status IS NULL OR old_status IN ('verified', 'stale', 'expired', 'disputed')
    ),
    new_status TEXT NOT NULL CHECK (
        new_status IN ('verified', 'stale', 'expired', 'disputed')
    ),
    source_evidence_bundle_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (namespace_verification_id) REFERENCES namespace_verifications(namespace_verification_id),
    FOREIGN KEY (source_evidence_bundle_id) REFERENCES namespace_verification_evidence_bundles(evidence_bundle_id)
);

CREATE INDEX idx_namespace_verification_revalidation_events_verification
    ON namespace_verification_revalidation_events(namespace_verification_id, created_at DESC);

CREATE INDEX idx_communities_namespace_verification
    ON communities(namespace_verification_id)
    WHERE namespace_verification_id IS NOT NULL;

ALTER TABLE communities
    ADD CONSTRAINT fk_communities_namespace_verification
    FOREIGN KEY (namespace_verification_id)
    REFERENCES namespace_verifications(namespace_verification_id)
    DEFERRABLE INITIALLY DEFERRED;
