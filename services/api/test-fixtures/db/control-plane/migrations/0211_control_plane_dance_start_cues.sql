-- Pin a randomized, versioned start cue to each new dance session and retain
-- the grader-observed cue decision and exact scored-window boundary.

ALTER TABLE dance_attempt_sessions
    ADD COLUMN start_cue_policy_version TEXT,
    ADD COLUMN start_cue_kind TEXT,
    ADD COLUMN start_cue_minimum_hold_ms INTEGER,
    ADD COLUMN start_cue_observation_window_ms INTEGER,
    ADD COLUMN start_cue_outcome TEXT,
    ADD COLUMN scored_window_start_ms INTEGER,
    ADD CONSTRAINT dance_attempt_session_start_cue_assignment_check CHECK (
        (
            start_cue_policy_version IS NULL
            AND start_cue_kind IS NULL
            AND start_cue_minimum_hold_ms IS NULL
            AND start_cue_observation_window_ms IS NULL
        )
        OR
        (
            start_cue_policy_version = 'dance_start_cue_gross_body_v1'
            AND start_cue_kind IN ('hands_on_head', 'arms_t', 'hands_on_hips')
            AND start_cue_minimum_hold_ms BETWEEN 250 AND 2000
            AND start_cue_observation_window_ms BETWEEN 1000 AND 5000
            AND start_cue_minimum_hold_ms < start_cue_observation_window_ms
        )
    ),
    ADD CONSTRAINT dance_attempt_session_start_cue_result_check CHECK (
        (
            start_cue_outcome IS NULL
            AND scored_window_start_ms IS NULL
        )
        OR
        (
            start_cue_outcome = 'passed'
            AND scored_window_start_ms BETWEEN 0 AND start_cue_observation_window_ms
        )
        OR
        (
            start_cue_outcome = 'failed'
            AND scored_window_start_ms IS NULL
        )
    );

ALTER TABLE dance_attempt_sessions
    DROP CONSTRAINT dance_attempt_session_terminal_reason_check,
    ADD CONSTRAINT dance_attempt_session_terminal_reason_check CHECK (
        terminal_reason IS NULL
        OR terminal_reason IN (
            'video_invalid', 'duration_out_of_range', 'insufficient_coverage',
            'insufficient_pose_presence', 'multiple_people', 'reference_replay',
            'duplicate_attempt', 'scoring_unavailable', 'below_platform_floor',
            'session_expired', 'upload_invalid', 'version_mismatch',
            'insufficient_motion', 'insufficient_alignment',
            'start_cue_mismatch', 'cancelled'
        )
    );

CREATE OR REPLACE FUNCTION reject_dance_start_cue_assignment_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF ROW(
        NEW.start_cue_policy_version,
        NEW.start_cue_kind,
        NEW.start_cue_minimum_hold_ms,
        NEW.start_cue_observation_window_ms
    ) IS DISTINCT FROM ROW(
        OLD.start_cue_policy_version,
        OLD.start_cue_kind,
        OLD.start_cue_minimum_hold_ms,
        OLD.start_cue_observation_window_ms
    ) THEN
        RAISE EXCEPTION 'dance start cue assignment is immutable';
    END IF;
    IF OLD.start_cue_outcome IS NOT NULL AND ROW(
        NEW.start_cue_outcome,
        NEW.scored_window_start_ms
    ) IS DISTINCT FROM ROW(
        OLD.start_cue_outcome,
        OLD.scored_window_start_ms
    ) THEN
        RAISE EXCEPTION 'dance start cue result is immutable once written';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dance_attempt_session_start_cue_immutable
BEFORE UPDATE ON dance_attempt_sessions
FOR EACH ROW
EXECUTE FUNCTION reject_dance_start_cue_assignment_mutation();
