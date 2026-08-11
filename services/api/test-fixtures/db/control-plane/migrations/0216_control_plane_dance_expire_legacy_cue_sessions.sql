-- 0212 assigned predictable cues to sessions that predated server-generated
-- start cues. Expire every non-terminal session at this cutover so those
-- assignments can never be used for a recording. Capture must remain dark
-- until this migration has run.

UPDATE dance_attempt_sessions
SET status = 'expired',
    terminal_reason = 'session_expired',
    finalized_at = NOW(),
    grading_dispatch_claim_token = NULL,
    grading_dispatch_claim_expires_at = NULL,
    grading_next_dispatch_at = NULL,
    cleanup_status = CASE
      WHEN upload_object_key =
        'dance/attempt-media/' || dance_attempt_session_id || '/pending.mp4'
        THEN 'not_required'
      ELSE 'pending'
    END,
    cleanup_attempt_count = 0,
    cleanup_next_attempt_at = CASE
      WHEN upload_object_key =
        'dance/attempt-media/' || dance_attempt_session_id || '/pending.mp4'
        THEN NULL
      ELSE NOW()
    END,
    cleanup_last_error = NULL,
    updated_at = NOW()
WHERE status IN ('initialized', 'uploading', 'submitted', 'grading');
