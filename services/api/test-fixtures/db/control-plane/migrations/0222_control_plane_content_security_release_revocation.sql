-- A staged scanner build can be rejected without pretending it was activated,
-- and a retired release can be revoked when later evidence invalidates it.
-- Revocation remains terminal; the immutable release identity is unchanged.

ALTER TABLE content_security_scanner_releases
    DROP CONSTRAINT content_security_scanner_release_lifecycle_check;

-- migration-safety: existing-table-check-reviewed: every existing release that
-- satisfies the 0219 constraint also satisfies this strictly broader lifecycle
-- constraint; no data rewrite is required.
ALTER TABLE content_security_scanner_releases
    ADD CONSTRAINT content_security_scanner_release_lifecycle_check CHECK (
        (status = 'staged' AND activated_at IS NULL AND retired_at IS NULL)
        OR (status = 'active' AND activated_at IS NOT NULL AND retired_at IS NULL)
        OR (status = 'retired' AND activated_at IS NOT NULL AND retired_at IS NOT NULL)
        OR (status = 'revoked' AND retired_at IS NOT NULL)
    );

CREATE OR REPLACE FUNCTION enforce_content_security_scanner_release_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'content security scanner release records cannot be deleted'
            USING ERRCODE = '23514';
    END IF;
    IF ROW(
        NEW.security_scan_profile,
        NEW.source_revision,
        NEW.runtime_lock_sha256,
        NEW.base_image_digest,
        NEW.engine_image_digest,
        NEW.engine_version,
        NEW.signature_version,
        NEW.signature_date,
        NEW.definition_digest,
        NEW.deployed_image_digest,
        NEW.sbom_ref,
        NEW.corpus_evidence_ref,
        NEW.created_at
    ) IS DISTINCT FROM ROW(
        OLD.security_scan_profile,
        OLD.source_revision,
        OLD.runtime_lock_sha256,
        OLD.base_image_digest,
        OLD.engine_image_digest,
        OLD.engine_version,
        OLD.signature_version,
        OLD.signature_date,
        OLD.definition_digest,
        OLD.deployed_image_digest,
        OLD.sbom_ref,
        OLD.corpus_evidence_ref,
        OLD.created_at
    ) THEN
        RAISE EXCEPTION 'content security scanner release identity is immutable'
            USING ERRCODE = '23514';
    END IF;
    IF NOT (
        (OLD.status = 'staged' AND NEW.status IN ('staged', 'active', 'revoked'))
        OR (OLD.status = 'active' AND NEW.status IN ('active', 'retired', 'revoked'))
        OR (OLD.status = 'retired' AND NEW.status IN ('retired', 'revoked'))
        OR (OLD.status = 'revoked' AND NEW.status = 'revoked')
    ) THEN
        RAISE EXCEPTION 'invalid content security scanner release transition'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
