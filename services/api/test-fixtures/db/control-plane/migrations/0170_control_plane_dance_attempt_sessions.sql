-- Durable coordination for one-upload dance grading sessions.
-- Raw-media object keys live only here; shard evidence must never contain them.

CREATE TABLE dance_attempt_sessions (
    dance_attempt_session_id TEXT PRIMARY KEY,
    dance_attempt_id TEXT NOT NULL UNIQUE,
    subject_user_id TEXT NOT NULL REFERENCES users(user_id),
    community_id TEXT NOT NULL REFERENCES communities(community_id),
    host_post_id TEXT NOT NULL,
    referenced_song_post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT NOT NULL
        REFERENCES song_artifact_bundles(song_artifact_bundle_id),
    dance_choreography_id TEXT NOT NULL,
    dance_choreography_revision_id TEXT NOT NULL,
    reference_content_sha256 TEXT NOT NULL CHECK (
        reference_content_sha256 ~ '^[0-9a-f]{64}$'
    ),
    reference_feature_ref TEXT NOT NULL,
    reference_feature_sha256 TEXT NOT NULL CHECK (
        reference_feature_sha256 ~ '^[0-9a-f]{64}$'
    ),
    reference_feature_size_bytes BIGINT NOT NULL CHECK (
        reference_feature_size_bytes > 0
    ),
    pose_model_version TEXT NOT NULL,
    pose_model_sha256 TEXT NOT NULL CHECK (
        pose_model_sha256 ~ '^[0-9a-f]{64}$'
    ),
    feature_schema_version TEXT NOT NULL,
    scorer_version TEXT NOT NULL,
    artifact_version TEXT NOT NULL,
    required_calibration_version TEXT NOT NULL,
    required_calibration_checksum TEXT NOT NULL CHECK (
        required_calibration_checksum ~ '^[0-9a-f]{64}$'
    ),
    required_fingerprint_policy_version TEXT NOT NULL,
    required_integrity_policy_version TEXT NOT NULL,
    mirror_policy TEXT NOT NULL CHECK (mirror_policy IN ('strict', 'allowed')),
    status TEXT NOT NULL CHECK (
        status IN (
            'initialized', 'uploading', 'submitted', 'grading',
            'finalized', 'rejected', 'failed', 'expired'
        )
    ),
    activity_date DATE NOT NULL,
    activity_timezone TEXT NOT NULL,
    creation_idempotency_key TEXT NOT NULL,
    upload_object_key TEXT NOT NULL UNIQUE,
    expected_mime_type TEXT NOT NULL CHECK (expected_mime_type = 'video/mp4'),
    maximum_bytes BIGINT NOT NULL CHECK (
        maximum_bytes > 0 AND maximum_bytes <= 67108864
    ),
    observed_size_bytes BIGINT CHECK (
        observed_size_bytes IS NULL
        OR (observed_size_bytes > 0 AND observed_size_bytes <= maximum_bytes)
    ),
    observed_etag TEXT,
    observed_content_sha256 TEXT CHECK (
        observed_content_sha256 IS NULL
        OR observed_content_sha256 ~ '^[0-9a-f]{64}$'
    ),
    capture_mode TEXT CHECK (
        capture_mode IS NULL OR capture_mode = 'in_app_camera'
    ),
    grading_dispatch_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
        grading_dispatch_attempt_count BETWEEN 0 AND 5
    ),
    grading_dispatch_claim_token TEXT,
    grading_dispatch_claim_expires_at TIMESTAMPTZ,
    grading_dispatch_id TEXT,
    grading_dispatched_at TIMESTAMPTZ,
    grading_next_dispatch_at TIMESTAMPTZ,
    grading_dispatch_last_error TEXT,
    grader_result_digest TEXT CHECK (
        grader_result_digest IS NULL
        OR grader_result_digest ~ '^[0-9a-f]{64}$'
    ),
    terminal_outcome TEXT CHECK (
        terminal_outcome IS NULL
        OR terminal_outcome IN ('scored', 'rejected', 'failed')
    ),
    terminal_reason TEXT CHECK (
        terminal_reason IS NULL
        OR terminal_reason IN (
            'video_invalid', 'duration_out_of_range', 'insufficient_coverage',
            'insufficient_pose_presence', 'multiple_people', 'reference_replay',
            'duplicate_attempt', 'scoring_unavailable', 'below_platform_floor',
            'session_expired', 'upload_invalid', 'version_mismatch'
        )
    ),
    score_bps INTEGER CHECK (
        score_bps IS NULL OR score_bps BETWEEN 0 AND 10000
    ),
    calibration_version TEXT,
    calibration_checksum TEXT CHECK (
        calibration_checksum IS NULL
        OR calibration_checksum ~ '^[0-9a-f]{64}$'
    ),
    calibration_admitted INTEGER CHECK (
        calibration_admitted IS NULL OR calibration_admitted IN (0, 1)
    ),
    cleanup_status TEXT NOT NULL DEFAULT 'not_required' CHECK (
        cleanup_status IN ('not_required', 'pending', 'deleted', 'retrying', 'failed')
    ),
    cleanup_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
        cleanup_attempt_count BETWEEN 0 AND 20
    ),
    cleanup_next_attempt_at TIMESTAMPTZ,
    cleanup_last_error TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    submitted_at TIMESTAMPTZ,
    finalized_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (subject_user_id, creation_idempotency_key),
    FOREIGN KEY (
        dance_choreography_id,
        dance_choreography_revision_id
    ) REFERENCES dance_choreography_revisions(
        dance_choreography_id,
        dance_choreography_revision_id
    ),
    CONSTRAINT dance_attempt_session_observed_upload_check CHECK (
      (
        (observed_size_bytes IS NULL
          AND observed_etag IS NULL
          AND observed_content_sha256 IS NULL
          AND capture_mode IS NULL
          AND submitted_at IS NULL)
        OR
        (observed_size_bytes IS NOT NULL
          AND observed_etag IS NOT NULL
          AND observed_content_sha256 IS NOT NULL
          AND capture_mode IS NOT NULL
          AND submitted_at IS NOT NULL)
      ) IS TRUE
    ),
    CONSTRAINT dance_attempt_session_dispatch_check CHECK (
      (
        (
          grading_dispatch_claim_token IS NULL
          AND grading_dispatch_claim_expires_at IS NULL
        )
        OR
        (
          grading_dispatch_claim_token IS NOT NULL
          AND grading_dispatch_claim_expires_at IS NOT NULL
          AND status IN ('submitted', 'grading')
        )
      )
      AND (
        grading_dispatch_id IS NULL
        OR (
          grading_dispatched_at IS NOT NULL
          AND grading_dispatch_attempt_count > 0
        )
      )
      AND (
        status IN ('submitted', 'grading')
        OR (
          grading_dispatch_claim_token IS NULL
          AND grading_dispatch_claim_expires_at IS NULL
          AND grading_next_dispatch_at IS NULL
        )
      )
    ),
    CONSTRAINT dance_attempt_session_terminal_check CHECK (
      (
        status IN ('initialized', 'uploading', 'submitted', 'grading')
        AND finalized_at IS NULL
        AND terminal_outcome IS NULL
        AND terminal_reason IS NULL
        AND grader_result_digest IS NULL
        AND score_bps IS NULL
        AND calibration_version IS NULL
        AND calibration_checksum IS NULL
        AND calibration_admitted IS NULL
      )
      OR (
        status = 'expired'
        AND finalized_at IS NOT NULL
        AND terminal_outcome IS NULL
        AND terminal_reason = 'session_expired'
        AND grader_result_digest IS NULL
        AND score_bps IS NULL
        AND calibration_version IS NULL
        AND calibration_checksum IS NULL
        AND calibration_admitted IS NULL
      )
      OR (
        status IN ('finalized', 'rejected', 'failed')
        AND finalized_at IS NOT NULL
        AND terminal_outcome IS NOT NULL
        AND grader_result_digest IS NOT NULL
        AND calibration_version IS NOT NULL
        AND calibration_checksum IS NOT NULL
        AND calibration_admitted IS NOT NULL
        AND (
          (status = 'finalized'
            AND terminal_outcome = 'scored'
            AND score_bps IS NOT NULL)
          OR
          (status = 'rejected'
            AND terminal_outcome = 'rejected'
            AND terminal_reason IS NOT NULL
            AND score_bps IS NULL)
          OR
          (status = 'failed'
            AND terminal_outcome = 'failed'
            AND terminal_reason IS NOT NULL
            AND score_bps IS NULL)
        )
      )
    ),
    CONSTRAINT dance_attempt_session_cleanup_check CHECK (
      (
        cleanup_status = 'not_required'
        AND cleanup_attempt_count = 0
        AND cleanup_next_attempt_at IS NULL
        AND deleted_at IS NULL
        AND status IN ('initialized', 'uploading')
      )
      OR (
        cleanup_status IN ('pending', 'retrying', 'failed')
        AND deleted_at IS NULL
        AND status IN ('submitted', 'grading', 'finalized', 'rejected', 'failed', 'expired')
      )
      OR (
        cleanup_status = 'deleted'
        AND deleted_at IS NOT NULL
        AND cleanup_next_attempt_at IS NULL
      )
    )
);

CREATE INDEX idx_dance_attempt_sessions_dispatch_due
    ON dance_attempt_sessions(grading_next_dispatch_at, created_at)
    WHERE status IN ('submitted', 'grading')
      AND grading_next_dispatch_at IS NOT NULL;

CREATE INDEX idx_dance_attempt_sessions_cleanup_due
    ON dance_attempt_sessions(cleanup_next_attempt_at, created_at)
    WHERE cleanup_status IN ('pending', 'retrying');

CREATE INDEX idx_dance_attempt_sessions_subject_recent
    ON dance_attempt_sessions(subject_user_id, created_at DESC);

CREATE INDEX idx_dance_attempt_sessions_expiry
    ON dance_attempt_sessions(expires_at)
    WHERE status IN ('initialized', 'uploading');

CREATE TABLE dance_attempt_fingerprints (
    dance_attempt_id TEXT PRIMARY KEY,
    dance_attempt_session_id TEXT NOT NULL UNIQUE
        REFERENCES dance_attempt_sessions(dance_attempt_session_id),
    subject_user_id TEXT NOT NULL REFERENCES users(user_id),
    dance_choreography_revision_id TEXT NOT NULL
        REFERENCES dance_choreography_revisions(dance_choreography_revision_id),
    fingerprint_policy_version TEXT NOT NULL,
    whole_attempt_hmac_sha256 TEXT NOT NULL CHECK (
        whole_attempt_hmac_sha256 ~ '^[0-9a-f]{64}$'
    ),
    segment_hmac_sha256_json JSONB NOT NULL CHECK (
        LENGTH(CAST(segment_hmac_sha256_json AS TEXT)) BETWEEN 2 AND 2200
    ),
    terminal_integrity_outcome TEXT NOT NULL CHECK (
        terminal_integrity_outcome IN ('passed', 'reference_replay', 'duplicate_attempt')
    ),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dance_attempt_fingerprints_whole
    ON dance_attempt_fingerprints(
        dance_choreography_revision_id,
        whole_attempt_hmac_sha256,
        expires_at
    );

CREATE INDEX idx_dance_attempt_fingerprints_expiry
    ON dance_attempt_fingerprints(expires_at);
