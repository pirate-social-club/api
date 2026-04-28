ALTER TABLE namespace_verification_sessions
    DROP CONSTRAINT IF EXISTS namespace_verification_sessions_challenge_kind_check;

UPDATE namespace_verification_sessions
SET challenge_kind = 'fabric_txt_publish'
WHERE family = 'spaces'
  AND challenge_kind = 'schnorr_sign';

ALTER TABLE namespace_verification_sessions
    ADD CONSTRAINT namespace_verification_sessions_challenge_kind_check
    CHECK (
        challenge_kind IS NULL OR challenge_kind IN ('dns_txt', 'fabric_txt_publish')
    );

ALTER TABLE namespace_verification_assertions
    DROP CONSTRAINT IF EXISTS namespace_verification_assertions_assertion_name_check;

UPDATE namespace_verification_assertions
SET assertion_name = 'fabric_publish_verified'
WHERE family = 'spaces'
  AND assertion_name = 'live_signature_verified';

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

UPDATE namespace_verification_evidence_bundles
SET evidence_kind = 'fabric_publish'
WHERE family = 'spaces'
  AND evidence_kind = 'challenge_signature';

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
