ALTER TABLE namespace_verification_sessions
    DROP CONSTRAINT IF EXISTS namespace_verification_sessions_family_check;

ALTER TABLE namespace_verification_sessions
    ADD CONSTRAINT namespace_verification_sessions_family_check
    CHECK (family IN ('hns', 'spaces'));

ALTER TABLE namespace_verifications
    DROP CONSTRAINT IF EXISTS namespace_verifications_family_check;

ALTER TABLE namespace_verifications
    ADD CONSTRAINT namespace_verifications_family_check
    CHECK (family IN ('hns', 'spaces'));

ALTER TABLE namespace_verification_evidence_bundles
    DROP CONSTRAINT IF EXISTS namespace_verification_evidence_bundles_family_check;

ALTER TABLE namespace_verification_evidence_bundles
    ADD CONSTRAINT namespace_verification_evidence_bundles_family_check
    CHECK (family IN ('hns', 'spaces'));

ALTER TABLE namespace_verification_sessions
    ADD COLUMN IF NOT EXISTS challenge_kind TEXT CHECK (
        challenge_kind IS NULL OR challenge_kind IN ('dns_txt', 'fabric_txt_publish')
    ),
    ADD COLUMN IF NOT EXISTS challenge_payload_json JSONB,
    ADD COLUMN IF NOT EXISTS anchor_height BIGINT,
    ADD COLUMN IF NOT EXISTS anchor_block_hash TEXT,
    ADD COLUMN IF NOT EXISTS anchor_root_hash TEXT,
    ADD COLUMN IF NOT EXISTS proof_root_hash TEXT;

ALTER TABLE namespace_verifications
    ADD COLUMN IF NOT EXISTS anchor_height BIGINT,
    ADD COLUMN IF NOT EXISTS anchor_block_hash TEXT,
    ADD COLUMN IF NOT EXISTS anchor_root_hash TEXT,
    ADD COLUMN IF NOT EXISTS proof_root_hash TEXT;

ALTER TABLE namespace_verifications
    ALTER COLUMN root_control_verified DROP NOT NULL,
    ALTER COLUMN expiry_horizon_sufficient DROP NOT NULL,
    ALTER COLUMN routing_enabled DROP NOT NULL,
    ALTER COLUMN pirate_dns_authority_verified DROP NOT NULL,
    ALTER COLUMN pirate_web_routing_allowed DROP NOT NULL,
    ALTER COLUMN pirate_subdomain_issuance_allowed DROP NOT NULL;

ALTER TABLE namespace_verification_sessions
    DROP CONSTRAINT IF EXISTS namespace_verification_sessions_operation_class_check;

ALTER TABLE namespace_verification_sessions
    ADD CONSTRAINT namespace_verification_sessions_operation_class_check
    CHECK (
        operation_class IS NULL OR operation_class IN (
            'owner_managed_namespace',
            'routing_only_namespace',
            'pirate_delegated_namespace',
            'owner_signed_updates_namespace'
        )
    );

ALTER TABLE namespace_verifications
    DROP CONSTRAINT IF EXISTS namespace_verifications_operation_class_check;

ALTER TABLE namespace_verifications
    ADD CONSTRAINT namespace_verifications_operation_class_check
    CHECK (
        operation_class IS NULL OR operation_class IN (
            'owner_managed_namespace',
            'routing_only_namespace',
            'pirate_delegated_namespace',
            'owner_signed_updates_namespace'
        )
    );

ALTER TABLE namespace_verification_assertions
    ADD COLUMN IF NOT EXISTS family TEXT;

UPDATE namespace_verification_assertions AS a
SET family = s.family
FROM namespace_verification_sessions AS s
WHERE a.namespace_verification_session_id = s.namespace_verification_session_id
  AND a.family IS NULL;

ALTER TABLE namespace_verification_assertions
    ALTER COLUMN family SET NOT NULL;

ALTER TABLE namespace_verification_assertions
    DROP CONSTRAINT IF EXISTS namespace_verification_assertions_family_check;

ALTER TABLE namespace_verification_assertions
    ADD CONSTRAINT namespace_verification_assertions_family_check
    CHECK (family IN ('hns', 'spaces'));

ALTER TABLE namespace_verification_assertions
    DROP CONSTRAINT IF EXISTS namespace_verification_assertions_assertion_name_check;

ALTER TABLE namespace_verification_assertions
    ADD CONSTRAINT namespace_verification_assertions_assertion_name_check
    CHECK (
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
    );

ALTER TABLE namespace_verification_evidence_bundles
    DROP CONSTRAINT IF EXISTS namespace_verification_evidence_bundles_evidence_kind_check;

ALTER TABLE namespace_verification_evidence_bundles
    ADD CONSTRAINT namespace_verification_evidence_bundles_evidence_kind_check
    CHECK (
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
    );

ALTER TABLE namespace_verification_revalidation_events
    DROP CONSTRAINT IF EXISTS namespace_verification_revalidation_events_trigger_check;

ALTER TABLE namespace_verification_revalidation_events
    ADD CONSTRAINT namespace_verification_revalidation_events_trigger_check
    CHECK (
        trigger IN (
            'manual_refresh',
            'scheduled_refresh',
            'create_time_recheck',
            'delegation_change',
            'expiry_change',
            'suspected_transfer',
            'contradiction_detected'
        )
    );

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

COMMENT ON COLUMN namespace_verification_sessions.challenge_host IS
    'Legacy HNS-only denormalized challenge field. New writes should use challenge_kind plus challenge_payload_json.';

COMMENT ON COLUMN namespace_verification_sessions.challenge_txt_value IS
    'Legacy HNS-only denormalized challenge field. New writes should use challenge_kind plus challenge_payload_json.';

COMMENT ON COLUMN namespace_verification_sessions.challenge_kind IS
    'Canonical cross-family challenge discriminator for new namespace verification sessions.';

COMMENT ON COLUMN namespace_verification_sessions.challenge_payload_json IS
    'Canonical family-specific challenge payload for new namespace verification sessions.';

COMMENT ON COLUMN namespace_verification_sessions.anchor_height IS
    'Optional cross-family convenience projection. Spaces sessions may persist accepted anchor height here; canonical evidence still lives in evidence bundles.';

COMMENT ON COLUMN namespace_verification_sessions.anchor_block_hash IS
    'Optional cross-family convenience projection for accepted anchor block hash.';

COMMENT ON COLUMN namespace_verification_sessions.anchor_root_hash IS
    'Optional cross-family convenience projection for accepted anchor root hash.';

COMMENT ON COLUMN namespace_verification_sessions.proof_root_hash IS
    'Optional cross-family convenience projection for the verified proof root hash.';

COMMENT ON COLUMN namespace_verifications.root_exists IS
    'Required convenience projection for all families. Populate from the accepted root_exists assertion; Spaces rows should set this to true when accepted.';

COMMENT ON COLUMN namespace_verifications.root_control_verified IS
    'Legacy HNS-specific convenience projection. New family-specific assertion state should be read from namespace_verification_assertions.';

COMMENT ON COLUMN namespace_verifications.expiry_horizon_sufficient IS
    'Legacy HNS-specific convenience projection. New family-specific assertion state should be read from namespace_verification_assertions.';

COMMENT ON COLUMN namespace_verifications.routing_enabled IS
    'Legacy HNS-specific convenience projection. New family-specific assertion state should be read from namespace_verification_assertions.';

COMMENT ON COLUMN namespace_verifications.pirate_dns_authority_verified IS
    'Legacy HNS-specific convenience projection. New family-specific assertion state should be read from namespace_verification_assertions.';

COMMENT ON COLUMN namespace_verifications.pirate_web_routing_allowed IS
    'Legacy HNS-specific convenience projection. New family-specific capability state should be read from namespace_verification_capabilities.';

COMMENT ON COLUMN namespace_verifications.pirate_subdomain_issuance_allowed IS
    'Legacy HNS-specific convenience projection. New family-specific capability state should be read from namespace_verification_capabilities.';

COMMENT ON COLUMN namespace_verifications.anchor_height IS
    'Optional cross-family convenience projection. Spaces verifications may persist accepted anchor height here; canonical evidence still lives in evidence bundles.';

COMMENT ON COLUMN namespace_verifications.anchor_block_hash IS
    'Optional cross-family convenience projection for accepted anchor block hash.';

COMMENT ON COLUMN namespace_verifications.anchor_root_hash IS
    'Optional cross-family convenience projection for accepted anchor root hash.';

COMMENT ON COLUMN namespace_verifications.proof_root_hash IS
    'Optional cross-family convenience projection for the verified proof root hash.';

COMMENT ON COLUMN namespace_verification_evidence_bundles.resolver_path_json IS
    'Legacy HNS-shaped name now used as a generic observation-path metadata payload for all namespace families.';

COMMENT ON COLUMN namespace_verification_evidence_bundles.raw_response_json IS
    'Generic raw evidence payload for all namespace families despite the HNS-oriented column name.';

COMMENT ON TABLE namespace_verification_assertions IS
    'Canonical assertion store. Assertion names are family-scoped and family is persisted explicitly on each row.';

COMMENT ON TABLE namespace_verification_capabilities IS
    'Canonical capability store for new namespace verification writes. Existing HNS verifications are backfilled from legacy fixed columns.';
