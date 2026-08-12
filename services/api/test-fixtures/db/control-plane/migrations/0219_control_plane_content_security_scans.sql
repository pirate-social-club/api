-- Durable authority for malware-scanner promotion, queue coordination, scan
-- evidence, and audited reads of isolated source plaintext. Queue messages
-- contain only scan_job_id; the API resolves every other expected value here.

CREATE TABLE content_security_scanner_releases (
    scanner_release_id TEXT PRIMARY KEY,
    security_scan_profile TEXT NOT NULL
        CHECK (length(trim(security_scan_profile)) > 0),
    status TEXT NOT NULL CHECK (
        status IN ('staged', 'active', 'retired', 'revoked')
    ),
    source_revision TEXT NOT NULL CHECK (length(trim(source_revision)) > 0),
    runtime_lock_sha256 TEXT NOT NULL
        CHECK (runtime_lock_sha256 ~ '^[a-f0-9]{64}$'),
    base_image_digest TEXT NOT NULL
        CHECK (base_image_digest ~ '^sha256:[a-f0-9]{64}$'),
    engine_image_digest TEXT NOT NULL
        CHECK (engine_image_digest ~ '^sha256:[a-f0-9]{64}$'),
    engine_version TEXT NOT NULL CHECK (length(trim(engine_version)) > 0),
    signature_version TEXT NOT NULL CHECK (length(trim(signature_version)) > 0),
    signature_date TIMESTAMPTZ NOT NULL,
    definition_digest TEXT NOT NULL
        CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
    deployed_image_digest TEXT NOT NULL
        CHECK (deployed_image_digest ~ '^sha256:[a-f0-9]{64}$'),
    sbom_ref TEXT NOT NULL CHECK (length(trim(sbom_ref)) > 0),
    corpus_evidence_ref TEXT NOT NULL
        CHECK (length(trim(corpus_evidence_ref)) > 0),
    created_at TIMESTAMPTZ NOT NULL,
    activated_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    CONSTRAINT content_security_scanner_release_lifecycle_check CHECK (
        (status = 'staged' AND activated_at IS NULL AND retired_at IS NULL)
        OR (status = 'active' AND activated_at IS NOT NULL AND retired_at IS NULL)
        OR (status IN ('retired', 'revoked') AND activated_at IS NOT NULL AND retired_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_content_security_scanner_releases_active_profile
    ON content_security_scanner_releases(security_scan_profile)
    WHERE status = 'active';

CREATE TABLE content_security_scan_jobs (
    scan_job_id TEXT PRIMARY KEY,
    content_blob_id TEXT NOT NULL
        REFERENCES content_blobs(content_blob_id) ON DELETE RESTRICT,
    scanner_release_id TEXT NOT NULL
        REFERENCES content_security_scanner_releases(scanner_release_id) ON DELETE RESTRICT,
    scan_sequence INTEGER NOT NULL CHECK (scan_sequence > 0),
    request_reason TEXT NOT NULL CHECK (
        request_reason IN (
            'initial_upload',
            'definition_refresh',
            'buyer_report',
            'moderation',
            'operator'
        )
    ),
    security_scan_profile TEXT NOT NULL
        CHECK (length(trim(security_scan_profile)) > 0),
    expected_content_hash TEXT NOT NULL
        CHECK (expected_content_hash ~ '^0x[a-f0-9]{64}$'),
    expected_size_bytes BIGINT NOT NULL CHECK (expected_size_bytes > 0),
    status TEXT NOT NULL CHECK (
        status IN (
            'queued',
            'running',
            'retryable_error',
            'succeeded',
            'dead_lettered',
            'cancelled'
        )
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_error_code TEXT,
    queued_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT content_security_scan_jobs_sequence_unique
        UNIQUE (content_blob_id, scan_sequence),
    CONSTRAINT content_security_scan_jobs_attempt_limit_check CHECK (
        attempt_count <= max_attempts
    ),
    CONSTRAINT content_security_scan_jobs_lease_pair_check CHECK (
        (status = 'running') = (lease_owner IS NOT NULL)
        AND (lease_owner IS NULL) = (lease_expires_at IS NULL)
    ),
    CONSTRAINT content_security_scan_jobs_running_lease_check CHECK (
        status <> 'running'
        OR (lease_owner IS NOT NULL AND started_at IS NOT NULL)
    ),
    CONSTRAINT content_security_scan_jobs_terminal_check CHECK (
        (status IN ('succeeded', 'dead_lettered', 'cancelled')) =
        (completed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_content_security_scan_jobs_active_blob
    ON content_security_scan_jobs(content_blob_id)
    WHERE status IN ('queued', 'running', 'retryable_error');

CREATE INDEX idx_content_security_scan_jobs_dispatch
    ON content_security_scan_jobs(status, queued_at, scan_job_id)
    WHERE status IN ('queued', 'retryable_error');

CREATE TABLE content_security_scan_results (
    scan_result_id TEXT PRIMARY KEY,
    scan_job_id TEXT NOT NULL
        REFERENCES content_security_scan_jobs(scan_job_id) ON DELETE RESTRICT,
    content_blob_id TEXT NOT NULL
        REFERENCES content_blobs(content_blob_id) ON DELETE RESTRICT,
    scanner_release_id TEXT NOT NULL
        REFERENCES content_security_scanner_releases(scanner_release_id) ON DELETE RESTRICT,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^0x[a-f0-9]{64}$'),
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
    outcome TEXT NOT NULL CHECK (
        outcome IN ('clean', 'suspicious', 'malicious', 'error')
    ),
    security_scan_profile TEXT NOT NULL
        CHECK (length(trim(security_scan_profile)) > 0),
    scanner_policy_version TEXT NOT NULL
        CHECK (length(trim(scanner_policy_version)) > 0),
    engine_version TEXT NOT NULL CHECK (length(trim(engine_version)) > 0),
    signature_version TEXT NOT NULL CHECK (length(trim(signature_version)) > 0),
    signature_date TIMESTAMPTZ NOT NULL,
    engine_image_digest TEXT NOT NULL
        CHECK (engine_image_digest ~ '^sha256:[a-f0-9]{64}$'),
    definition_digest TEXT NOT NULL
        CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
    finding_code TEXT,
    error_code TEXT,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    recorded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT content_security_scan_results_attempt_unique
        UNIQUE (scan_job_id, attempt_number),
    CONSTRAINT content_security_scan_results_outcome_detail_check CHECK (
        (outcome = 'malicious' AND finding_code IS NOT NULL AND error_code IS NULL)
        OR (outcome = 'error' AND finding_code IS NULL AND error_code IS NOT NULL)
        OR (outcome IN ('clean', 'suspicious') AND error_code IS NULL)
    )
);

CREATE INDEX idx_content_security_scan_results_blob_recorded
    ON content_security_scan_results(content_blob_id, recorded_at DESC);

CREATE TABLE content_source_read_audits (
    source_read_audit_id TEXT PRIMARY KEY,
    scan_job_id TEXT NOT NULL
        REFERENCES content_security_scan_jobs(scan_job_id) ON DELETE RESTRICT,
    content_blob_id TEXT NOT NULL
        REFERENCES content_blobs(content_blob_id) ON DELETE RESTRICT,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    purpose TEXT NOT NULL CHECK (
        purpose IN (
            'initial_scan',
            'definition_rescan',
            'buyer_report_rescan',
            'moderation_inspection',
            'operator_rescan'
        )
    ),
    actor_role TEXT NOT NULL CHECK (
        actor_role IN ('scanner_job', 'platform_security_inspection')
    ),
    expected_content_hash TEXT NOT NULL
        CHECK (expected_content_hash ~ '^0x[a-f0-9]{64}$'),
    expected_size_bytes BIGINT NOT NULL CHECK (expected_size_bytes > 0),
    bytes_read BIGINT NOT NULL CHECK (bytes_read >= 0),
    outcome TEXT NOT NULL CHECK (
        outcome IN (
            'completed',
            'source_missing',
            'metadata_mismatch',
            'stream_error',
            'scanner_rejected'
        )
    ),
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT content_source_read_audits_attempt_unique
        UNIQUE (scan_job_id, attempt_number),
    CONSTRAINT content_source_read_audits_time_order_check CHECK (
        completed_at >= started_at
    )
);

CREATE INDEX idx_content_source_read_audits_blob_completed
    ON content_source_read_audits(content_blob_id, completed_at DESC);

CREATE OR REPLACE FUNCTION enforce_content_security_scan_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'content security scan evidence is immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER content_security_scan_results_immutable
BEFORE UPDATE OR DELETE ON content_security_scan_results
FOR EACH ROW EXECUTE FUNCTION enforce_content_security_scan_immutability();

CREATE TRIGGER content_source_read_audits_immutable
BEFORE UPDATE OR DELETE ON content_source_read_audits
FOR EACH ROW EXECUTE FUNCTION enforce_content_security_scan_immutability();

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
        OR (OLD.status = NEW.status AND OLD.status IN ('retired', 'revoked'))
    ) THEN
        RAISE EXCEPTION 'invalid content security scanner release transition'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER content_security_scanner_release_identity_immutable
BEFORE UPDATE OR DELETE ON content_security_scanner_releases
FOR EACH ROW EXECUTE FUNCTION enforce_content_security_scanner_release_identity();

CREATE OR REPLACE FUNCTION reject_content_security_scan_job_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'content security scan jobs cannot be deleted'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER content_security_scan_jobs_no_delete
BEFORE DELETE ON content_security_scan_jobs
FOR EACH ROW EXECUTE FUNCTION reject_content_security_scan_job_delete();

CREATE OR REPLACE FUNCTION enforce_content_security_scan_job_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(
        NEW.content_blob_id,
        NEW.scanner_release_id,
        NEW.scan_sequence,
        NEW.request_reason,
        NEW.security_scan_profile,
        NEW.expected_content_hash,
        NEW.expected_size_bytes,
        NEW.max_attempts,
        NEW.queued_at,
        NEW.created_at
    ) IS DISTINCT FROM ROW(
        OLD.content_blob_id,
        OLD.scanner_release_id,
        OLD.scan_sequence,
        OLD.request_reason,
        OLD.security_scan_profile,
        OLD.expected_content_hash,
        OLD.expected_size_bytes,
        OLD.max_attempts,
        OLD.queued_at,
        OLD.created_at
    ) THEN
        RAISE EXCEPTION 'content security scan job identity is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER content_security_scan_job_identity_immutable
BEFORE UPDATE ON content_security_scan_jobs
FOR EACH ROW EXECUTE FUNCTION enforce_content_security_scan_job_identity();

REVOKE ALL ON TABLE
    content_security_scanner_releases,
    content_security_scan_jobs,
    content_security_scan_results,
    content_source_read_audits
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE
ON TABLE
    content_security_scanner_releases,
    content_security_scan_jobs
TO control_plane_api_rw;

GRANT SELECT, INSERT
ON TABLE
    content_security_scan_results,
    content_source_read_audits
TO control_plane_api_rw;

GRANT SELECT
ON TABLE
    content_security_scanner_releases,
    content_security_scan_jobs,
    content_security_scan_results,
    content_source_read_audits
TO control_plane_api_ro, control_plane_ops_ro;
