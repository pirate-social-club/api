-- Make recording consent immutable and align persisted dance media envelopes
-- with the public V1 contract.

CREATE OR REPLACE FUNCTION enforce_dance_consent_receipt_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF (
        NEW.consent_policy_version,
        NEW.consented_at,
        NEW.consent_source
    ) IS DISTINCT FROM (
        OLD.consent_policy_version,
        OLD.consented_at,
        OLD.consent_source
    ) THEN
        RAISE EXCEPTION 'dance recording consent receipts are immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER dance_attempt_session_consent_receipt_immutable
BEFORE UPDATE OF consent_policy_version, consented_at, consent_source
ON dance_attempt_sessions
FOR EACH ROW
EXECUTE FUNCTION enforce_dance_consent_receipt_immutability();

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM dance_attempt_sessions
        WHERE observed_size_bytes > 19000000
    ) THEN
        RAISE EXCEPTION
            'cannot tighten dance maximum_bytes: an observed upload exceeds 19000000 bytes';
    END IF;
END;
$$;

UPDATE dance_attempt_sessions
SET maximum_bytes = 19000000,
    updated_at = NOW()
WHERE maximum_bytes > 19000000;

ALTER TABLE dance_attempt_sessions
    DROP CONSTRAINT dance_attempt_sessions_maximum_bytes_check,
    ADD CONSTRAINT dance_attempt_sessions_maximum_bytes_check CHECK (
        maximum_bytes > 0 AND maximum_bytes <= 19000000
    );

UPDATE dance_choreography_revisions
SET status = 'retired',
    retired_at = COALESCE(retired_at, NOW())
WHERE status = 'ready'
  AND reference_duration_ms > 30000;

UPDATE dance_choreographies AS choreography
SET status = 'disabled',
    active_revision_id = NULL,
    updated_at = NOW()
WHERE choreography.active_revision_id IN (
    SELECT revision.dance_choreography_revision_id
    FROM dance_choreography_revisions AS revision
    WHERE revision.status = 'retired'
      AND revision.reference_duration_ms > 30000
);

ALTER TABLE dance_choreography_revisions
    DROP CONSTRAINT dance_choreography_revisions_reference_duration_ms_check,
    ADD CONSTRAINT dance_choreography_revisions_reference_duration_ms_check CHECK (
        reference_duration_ms IS NULL
        OR reference_duration_ms BETWEEN 1000 AND 30000
        OR (
            status IN ('failed', 'retired')
            AND reference_duration_ms BETWEEN 1000 AND 90000
        )
    );
