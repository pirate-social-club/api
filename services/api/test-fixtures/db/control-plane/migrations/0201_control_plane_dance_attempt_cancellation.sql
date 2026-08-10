-- Distinguish user cancellation from TTL expiry and keep it terminal.

ALTER TABLE dance_attempt_sessions
    DROP CONSTRAINT dance_attempt_sessions_status_check;

-- migration-safety: existing-table-check-reviewed: widens the status allowlist with cancelled; all existing rows remain valid
ALTER TABLE dance_attempt_sessions
    ADD CONSTRAINT dance_attempt_sessions_status_check CHECK (
        status IN (
            'initialized', 'uploading', 'submitted', 'grading',
            'finalized', 'rejected', 'failed', 'expired', 'cancelled'
        )
    );

ALTER TABLE dance_attempt_sessions
    DROP CONSTRAINT dance_attempt_session_terminal_reason_check;

-- migration-safety: existing-table-check-reviewed: widens the terminal reason allowlist with cancelled; all existing rows remain valid
ALTER TABLE dance_attempt_sessions
    ADD CONSTRAINT dance_attempt_session_terminal_reason_check CHECK (
        terminal_reason IS NULL
        OR terminal_reason IN (
            'video_invalid', 'duration_out_of_range', 'insufficient_coverage',
            'insufficient_pose_presence', 'multiple_people', 'reference_replay',
            'duplicate_attempt', 'scoring_unavailable', 'below_platform_floor',
            'session_expired', 'upload_invalid', 'version_mismatch',
            'insufficient_motion', 'insufficient_alignment', 'cancelled'
        )
    );

ALTER TABLE dance_attempt_sessions
    DROP CONSTRAINT dance_attempt_session_terminal_check;

-- migration-safety: existing-table-check-reviewed: preserves every existing terminal-state branch and adds a disjoint cancelled branch
ALTER TABLE dance_attempt_sessions
    ADD CONSTRAINT dance_attempt_session_terminal_check CHECK (
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
        status = 'cancelled'
        AND finalized_at IS NOT NULL
        AND terminal_outcome IS NULL
        AND terminal_reason = 'cancelled'
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
    );

ALTER TABLE dance_attempt_sessions
    DROP CONSTRAINT dance_attempt_session_cleanup_check;

-- migration-safety: existing-table-check-reviewed: preserves existing cleanup combinations and adds cancelled to the applicable branches
ALTER TABLE dance_attempt_sessions
    ADD CONSTRAINT dance_attempt_session_cleanup_check CHECK (
      (
        cleanup_status = 'not_required'
        AND cleanup_attempt_count = 0
        AND cleanup_next_attempt_at IS NULL
        AND deleted_at IS NULL
        AND status IN ('initialized', 'uploading', 'cancelled')
      )
      OR (
        cleanup_status IN ('pending', 'retrying', 'failed')
        AND deleted_at IS NULL
        AND status IN (
          'submitted', 'grading', 'finalized', 'rejected', 'failed',
          'expired', 'cancelled'
        )
      )
      OR (
        cleanup_status = 'deleted'
        AND deleted_at IS NOT NULL
        AND cleanup_next_attempt_at IS NULL
      )
    );

CREATE OR REPLACE FUNCTION enforce_terminal_dance_attempt_session_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status IN ('finalized', 'rejected', 'failed', 'expired', 'cancelled') AND (
        NEW.status,
        NEW.terminal_outcome,
        NEW.terminal_reason,
        NEW.score_bps,
        NEW.calibration_version,
        NEW.calibration_checksum,
        NEW.calibration_admitted,
        NEW.grader_result_digest,
        NEW.finalized_at
    ) IS DISTINCT FROM (
        OLD.status,
        OLD.terminal_outcome,
        OLD.terminal_reason,
        OLD.score_bps,
        OLD.calibration_version,
        OLD.calibration_checksum,
        OLD.calibration_admitted,
        OLD.grader_result_digest,
        OLD.finalized_at
    ) THEN
        RAISE EXCEPTION 'terminal dance attempt session facts are immutable';
    END IF;
    RETURN NEW;
END;
$$;
