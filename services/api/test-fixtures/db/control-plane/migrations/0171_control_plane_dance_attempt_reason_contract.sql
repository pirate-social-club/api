-- Keep the bounded control-plane projection synchronized with scorer v1.

ALTER TABLE dance_attempt_sessions
    DROP CONSTRAINT dance_attempt_sessions_terminal_reason_check;

ALTER TABLE dance_attempt_sessions
    ADD CONSTRAINT dance_attempt_session_terminal_reason_check CHECK (
        terminal_reason IS NULL
        OR terminal_reason IN (
            'video_invalid', 'duration_out_of_range', 'insufficient_coverage',
            'insufficient_pose_presence', 'multiple_people', 'reference_replay',
            'duplicate_attempt', 'scoring_unavailable', 'below_platform_floor',
            'session_expired', 'upload_invalid', 'version_mismatch',
            'insufficient_motion', 'insufficient_alignment'
        )
    );

CREATE FUNCTION enforce_terminal_dance_attempt_session_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status IN ('finalized', 'rejected', 'failed', 'expired') AND (
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

CREATE TRIGGER dance_attempt_sessions_terminal_immutable
BEFORE UPDATE ON dance_attempt_sessions
FOR EACH ROW
EXECUTE FUNCTION enforce_terminal_dance_attempt_session_immutability();
