PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS communities_namespace_verification_insert_guard;
DROP TRIGGER IF EXISTS communities_namespace_verification_update_guard;

CREATE TABLE namespace_verification_sessions__new (
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
    challenge_expires_at TEXT,
    challenge_kind TEXT CHECK (
        challenge_kind IS NULL OR challenge_kind IN ('dns_txt', 'schnorr_sign')
    ),
    challenge_payload_json TEXT,
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
    anchor_height INTEGER,
    anchor_block_hash TEXT,
    anchor_root_hash TEXT,
    proof_root_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

INSERT INTO namespace_verification_sessions__new (
    namespace_verification_session_id,
    namespace_verification_id,
    user_id,
    family,
    submitted_root_label,
    normalized_root_label,
    status,
    challenge_host,
    challenge_txt_value,
    challenge_expires_at,
    challenge_kind,
    challenge_payload_json,
    root_exists,
    root_control_verified,
    expiry_horizon_sufficient,
    routing_enabled,
    pirate_dns_authority_verified,
    club_attach_allowed,
    pirate_web_routing_allowed,
    pirate_subdomain_issuance_allowed,
    control_class,
    operation_class,
    observation_provider,
    evidence_bundle_ref,
    failure_reason,
    accepted_at,
    expires_at,
    anchor_height,
    anchor_block_hash,
    anchor_root_hash,
    proof_root_hash,
    created_at,
    updated_at
)
SELECT
    namespace_verification_session_id,
    namespace_verification_id,
    user_id,
    family,
    submitted_root_label,
    normalized_root_label,
    status,
    challenge_host,
    challenge_txt_value,
    challenge_expires_at,
    CASE
        WHEN challenge_host IS NOT NULL OR challenge_txt_value IS NOT NULL THEN 'dns_txt'
        ELSE NULL
    END,
    NULL,
    root_exists,
    root_control_verified,
    expiry_horizon_sufficient,
    routing_enabled,
    pirate_dns_authority_verified,
    club_attach_allowed,
    pirate_web_routing_allowed,
    pirate_subdomain_issuance_allowed,
    control_class,
    operation_class,
    observation_provider,
    evidence_bundle_ref,
    failure_reason,
    accepted_at,
    expires_at,
    NULL,
    NULL,
    NULL,
    NULL,
    created_at,
    updated_at
FROM namespace_verification_sessions;

DROP TABLE namespace_verification_sessions;
ALTER TABLE namespace_verification_sessions__new RENAME TO namespace_verification_sessions;

CREATE UNIQUE INDEX idx_namespace_verification_sessions_verification_id
    ON namespace_verification_sessions(namespace_verification_id)
    WHERE namespace_verification_id IS NOT NULL;

CREATE INDEX idx_namespace_verification_sessions_user_status
    ON namespace_verification_sessions(user_id, status);

CREATE INDEX idx_namespace_verification_sessions_root_status
    ON namespace_verification_sessions(normalized_root_label, status);

CREATE TABLE namespace_verifications__new (
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
    observation_provider TEXT,
    evidence_bundle_ref TEXT,
    accepted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    anchor_height INTEGER,
    anchor_block_hash TEXT,
    anchor_root_hash TEXT,
    proof_root_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (source_namespace_verification_session_id) REFERENCES namespace_verification_sessions(namespace_verification_session_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

INSERT INTO namespace_verifications__new (
    namespace_verification_id,
    source_namespace_verification_session_id,
    user_id,
    family,
    normalized_root_label,
    status,
    root_exists,
    root_control_verified,
    expiry_horizon_sufficient,
    routing_enabled,
    pirate_dns_authority_verified,
    club_attach_allowed,
    pirate_web_routing_allowed,
    pirate_subdomain_issuance_allowed,
    control_class,
    operation_class,
    observation_provider,
    evidence_bundle_ref,
    accepted_at,
    expires_at,
    anchor_height,
    anchor_block_hash,
    anchor_root_hash,
    proof_root_hash,
    created_at,
    updated_at
)
SELECT
    namespace_verification_id,
    source_namespace_verification_session_id,
    user_id,
    family,
    normalized_root_label,
    status,
    root_exists,
    root_control_verified,
    expiry_horizon_sufficient,
    routing_enabled,
    pirate_dns_authority_verified,
    club_attach_allowed,
    pirate_web_routing_allowed,
    pirate_subdomain_issuance_allowed,
    control_class,
    operation_class,
    observation_provider,
    evidence_bundle_ref,
    accepted_at,
    expires_at,
    NULL,
    NULL,
    NULL,
    NULL,
    created_at,
    updated_at
FROM namespace_verifications;

DROP TABLE namespace_verifications;
ALTER TABLE namespace_verifications__new RENAME TO namespace_verifications;

CREATE UNIQUE INDEX idx_namespace_verifications_source_session
    ON namespace_verifications(source_namespace_verification_session_id);

CREATE INDEX idx_namespace_verifications_user_status
    ON namespace_verifications(user_id, status);

CREATE INDEX idx_namespace_verifications_root_status
    ON namespace_verifications(normalized_root_label, status);

CREATE TABLE namespace_verification_evidence_bundles__new (
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
            'challenge_signature',
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

INSERT INTO namespace_verification_evidence_bundles__new (
    evidence_bundle_id,
    namespace_verification_session_id,
    namespace_verification_id,
    family,
    normalized_root_label,
    evidence_kind,
    provider,
    resolver_path_json,
    raw_response_json,
    evidence_hash,
    observed_at,
    created_at,
    updated_at
)
SELECT
    evidence_bundle_id,
    namespace_verification_session_id,
    namespace_verification_id,
    family,
    normalized_root_label,
    evidence_kind,
    provider,
    resolver_path_json,
    raw_response_json,
    evidence_hash,
    observed_at,
    created_at,
    updated_at
FROM namespace_verification_evidence_bundles;

DROP TABLE namespace_verification_evidence_bundles;
ALTER TABLE namespace_verification_evidence_bundles__new RENAME TO namespace_verification_evidence_bundles;

CREATE INDEX idx_namespace_verification_evidence_session
    ON namespace_verification_evidence_bundles(namespace_verification_session_id, observed_at DESC);

CREATE INDEX idx_namespace_verification_evidence_verification
    ON namespace_verification_evidence_bundles(namespace_verification_id, observed_at DESC);

CREATE TABLE namespace_verification_assertions__new (
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
            'live_signature_verified',
            'anchor_fresh_enough',
            'owner_signed_updates_verified'
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

INSERT INTO namespace_verification_assertions__new (
    assertion_record_id,
    namespace_verification_session_id,
    namespace_verification_id,
    family,
    assertion_name,
    assertion_value,
    source_evidence_bundle_id,
    status,
    first_accepted_at,
    last_revalidated_at,
    created_at,
    updated_at
)
SELECT
    a.assertion_record_id,
    a.namespace_verification_session_id,
    a.namespace_verification_id,
    s.family,
    a.assertion_name,
    a.assertion_value,
    a.source_evidence_bundle_id,
    a.status,
    a.first_accepted_at,
    a.last_revalidated_at,
    a.created_at,
    a.updated_at
FROM namespace_verification_assertions AS a
INNER JOIN namespace_verification_sessions AS s
    ON s.namespace_verification_session_id = a.namespace_verification_session_id;

DROP TABLE namespace_verification_assertions;
ALTER TABLE namespace_verification_assertions__new RENAME TO namespace_verification_assertions;

CREATE INDEX idx_namespace_verification_assertions_session
    ON namespace_verification_assertions(namespace_verification_session_id, assertion_name);

CREATE INDEX idx_namespace_verification_assertions_verification
    ON namespace_verification_assertions(namespace_verification_id, assertion_name, status);

CREATE TABLE namespace_verification_revalidation_events__new (
    revalidation_event_id TEXT PRIMARY KEY,
    namespace_verification_id TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (
        trigger IN (
            'manual_refresh',
            'scheduled_refresh',
            'create_time_recheck',
            'delegation_change',
            'expiry_change',
            'suspected_transfer',
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

INSERT INTO namespace_verification_revalidation_events__new (
    revalidation_event_id,
    namespace_verification_id,
    trigger,
    old_assertions_json,
    new_assertions_json,
    old_capabilities_json,
    new_capabilities_json,
    old_status,
    new_status,
    source_evidence_bundle_id,
    created_at
)
SELECT
    revalidation_event_id,
    namespace_verification_id,
    trigger,
    old_assertions_json,
    new_assertions_json,
    old_capabilities_json,
    new_capabilities_json,
    old_status,
    new_status,
    source_evidence_bundle_id,
    created_at
FROM namespace_verification_revalidation_events;

DROP TABLE namespace_verification_revalidation_events;
ALTER TABLE namespace_verification_revalidation_events__new RENAME TO namespace_verification_revalidation_events;

CREATE INDEX idx_namespace_verification_revalidation_events_verification
    ON namespace_verification_revalidation_events(namespace_verification_id, created_at DESC);

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
    first_accepted_at TEXT,
    last_revalidated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (namespace_verification_session_id) REFERENCES namespace_verification_sessions(namespace_verification_session_id),
    FOREIGN KEY (namespace_verification_id) REFERENCES namespace_verifications(namespace_verification_id),
    FOREIGN KEY (source_evidence_bundle_id) REFERENCES namespace_verification_evidence_bundles(evidence_bundle_id)
);

INSERT INTO namespace_verification_capabilities (
    capability_record_id,
    namespace_verification_session_id,
    namespace_verification_id,
    family,
    capability_name,
    capability_value,
    status,
    first_accepted_at,
    last_revalidated_at,
    created_at,
    updated_at
)
SELECT
    'nvc_' || v.namespace_verification_id || '_club_attach_allowed',
    v.source_namespace_verification_session_id,
    v.namespace_verification_id,
    v.family,
    'club_attach_allowed',
    v.club_attach_allowed,
    CASE
        WHEN v.status = 'verified' THEN 'accepted'
        WHEN v.status = 'disputed' THEN 'disputed'
        ELSE 'stale'
    END,
    v.accepted_at,
    v.updated_at,
    v.created_at,
    v.updated_at
FROM namespace_verifications AS v
UNION ALL
SELECT
    'nvc_' || v.namespace_verification_id || '_pirate_web_routing_allowed',
    v.source_namespace_verification_session_id,
    v.namespace_verification_id,
    v.family,
    'pirate_web_routing_allowed',
    v.pirate_web_routing_allowed,
    CASE
        WHEN v.status = 'verified' THEN 'accepted'
        WHEN v.status = 'disputed' THEN 'disputed'
        ELSE 'stale'
    END,
    v.accepted_at,
    v.updated_at,
    v.created_at,
    v.updated_at
FROM namespace_verifications AS v
WHERE v.pirate_web_routing_allowed IS NOT NULL
UNION ALL
SELECT
    'nvc_' || v.namespace_verification_id || '_pirate_subdomain_issuance_allowed',
    v.source_namespace_verification_session_id,
    v.namespace_verification_id,
    v.family,
    'pirate_subdomain_issuance_allowed',
    v.pirate_subdomain_issuance_allowed,
    CASE
        WHEN v.status = 'verified' THEN 'accepted'
        WHEN v.status = 'disputed' THEN 'disputed'
        ELSE 'stale'
    END,
    v.accepted_at,
    v.updated_at,
    v.created_at,
    v.updated_at
FROM namespace_verifications AS v
WHERE v.pirate_subdomain_issuance_allowed IS NOT NULL;

CREATE INDEX idx_namespace_verification_capabilities_session
    ON namespace_verification_capabilities(namespace_verification_session_id, capability_name, status);

CREATE INDEX idx_namespace_verification_capabilities_verification
    ON namespace_verification_capabilities(namespace_verification_id, capability_name, status);

CREATE UNIQUE INDEX idx_namespace_verification_capabilities_session_name_status_unique
    ON namespace_verification_capabilities(namespace_verification_session_id, capability_name, status);

CREATE UNIQUE INDEX idx_namespace_verification_capabilities_verification_name_status_unique
    ON namespace_verification_capabilities(namespace_verification_id, capability_name, status)
    WHERE namespace_verification_id IS NOT NULL;

CREATE INDEX idx_communities_namespace_verification
    ON communities(namespace_verification_id)
    WHERE namespace_verification_id IS NOT NULL;

CREATE TRIGGER communities_namespace_verification_insert_guard
BEFORE INSERT ON communities
FOR EACH ROW
WHEN NEW.namespace_verification_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM namespace_verifications
        WHERE namespace_verification_id = NEW.namespace_verification_id
    )
BEGIN
    SELECT RAISE(ABORT, 'namespace_verification_id_not_found');
END;

CREATE TRIGGER communities_namespace_verification_update_guard
BEFORE UPDATE OF namespace_verification_id ON communities
FOR EACH ROW
WHEN NEW.namespace_verification_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM namespace_verifications
        WHERE namespace_verification_id = NEW.namespace_verification_id
    )
BEGIN
    SELECT RAISE(ABORT, 'namespace_verification_id_not_found');
END;

PRAGMA foreign_keys = ON;
