-- Placeholder attempt keys never name uploaded media. Repair expired rows that
-- were queued before placeholder-aware expiry shipped.

UPDATE dance_attempt_sessions
SET cleanup_status = 'not_required',
    cleanup_attempt_count = 0,
    cleanup_next_attempt_at = NULL,
    cleanup_last_error = NULL,
    updated_at = NOW()
WHERE status = 'expired'
  AND upload_object_key =
    'dance/attempt-media/' || dance_attempt_session_id || '/pending.mp4'
  AND cleanup_status IN ('pending', 'retrying', 'failed')
  AND deleted_at IS NULL;
