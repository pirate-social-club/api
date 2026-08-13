-- Provider-keyed attestation lifecycle constraints.
--
-- The repair audit must be clean before this migration is applied. Keep the
-- preflight explicit so a drifted database fails before any index is created;
-- the migration runner rolls the whole file back on failure.

DO $provider_keyed_attestation_constraints$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM user_attestations
        WHERE status = 'accepted'
          AND capability_key = 'unique_human'
        GROUP BY user_id, capability_key, provider
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'provider-keyed attestation migration blocked: duplicate accepted personhood evidence';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM user_attestations
        WHERE status = 'accepted'
          AND capability_key = 'nationality'
          AND source_identity_nullifier_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'provider-keyed attestation migration blocked: accepted document evidence is unbound';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM user_attestations a
        LEFT JOIN identity_nullifiers n
          ON n.identity_nullifier_id = a.source_identity_nullifier_id
         AND n.user_id = a.user_id
         AND n.provider = a.provider
         AND n.status = 'active'
        WHERE a.status = 'accepted'
          AND a.capability_key = 'nationality'
          AND n.identity_nullifier_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'provider-keyed attestation migration blocked: accepted document evidence has an invalid nullifier link';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM user_attestations
        WHERE status = 'accepted'
          AND capability_key = 'nationality'
          AND source_identity_nullifier_id IS NOT NULL
        GROUP BY user_id, capability_key, provider, source_identity_nullifier_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'provider-keyed attestation migration blocked: duplicate accepted document evidence';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM user_attestations
        WHERE status = 'accepted'
          AND capability_key IN ('minimum_age', 'age_over_18', 'gender')
        GROUP BY user_id, capability_key, provider
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'provider-keyed attestation migration blocked: duplicate accepted single-slot evidence';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM user_attestations
        WHERE status = 'accepted'
          AND source_verification_session_id IS NOT NULL
        GROUP BY source_verification_session_id, capability_key, provider
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'provider-keyed attestation migration blocked: duplicate accepted verification-session evidence';
    END IF;
END
$provider_keyed_attestation_constraints$;

-- migration-safety: existing-table-check-reviewed: the preflight above proves accepted nationality rows are bound.
ALTER TABLE user_attestations
    ADD CONSTRAINT user_attestations_accepted_nationality_bound_check
    CHECK (
        status <> 'accepted'
        OR capability_key <> 'nationality'
        OR source_identity_nullifier_id IS NOT NULL
    );

CREATE UNIQUE INDEX idx_user_attestations_accepted_personhood
    ON user_attestations (user_id, capability_key, provider)
    WHERE status = 'accepted'
      AND capability_key = 'unique_human';

CREATE UNIQUE INDEX idx_user_attestations_accepted_document
    ON user_attestations (
        user_id,
        capability_key,
        provider,
        source_identity_nullifier_id
    )
    WHERE status = 'accepted'
      AND capability_key = 'nationality'
      AND source_identity_nullifier_id IS NOT NULL;

CREATE UNIQUE INDEX idx_user_attestations_accepted_single_slot
    ON user_attestations (user_id, capability_key, provider)
    WHERE status = 'accepted'
      AND capability_key IN ('minimum_age', 'age_over_18', 'gender');

CREATE UNIQUE INDEX idx_user_attestations_accepted_session
    ON user_attestations (source_verification_session_id, capability_key, provider)
    WHERE status = 'accepted'
      AND source_verification_session_id IS NOT NULL;
