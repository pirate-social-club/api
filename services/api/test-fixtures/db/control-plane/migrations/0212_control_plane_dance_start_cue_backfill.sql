-- Remove the nullable start-cue transition for legacy non-terminal sessions.
-- The deterministic assignment is restricted to sessions created before cue
-- support; all new assignments remain cryptographically random in the API.

DROP TRIGGER dance_attempt_session_start_cue_immutable ON dance_attempt_sessions;

UPDATE dance_attempt_sessions
SET start_cue_policy_version = 'dance_start_cue_gross_body_v1',
    start_cue_kind = CASE (get_byte(decode(md5(dance_attempt_session_id), 'hex'), 0) % 3)
      WHEN 0 THEN 'hands_on_head'
      WHEN 1 THEN 'arms_t'
      ELSE 'hands_on_hips'
    END,
    start_cue_minimum_hold_ms = 500,
    start_cue_observation_window_ms = 2500,
    updated_at = NOW()
WHERE status IN ('initialized', 'uploading', 'submitted', 'grading')
  AND start_cue_policy_version IS NULL;

CREATE TRIGGER dance_attempt_session_start_cue_immutable
BEFORE UPDATE ON dance_attempt_sessions
FOR EACH ROW
EXECUTE FUNCTION reject_dance_start_cue_assignment_mutation();
