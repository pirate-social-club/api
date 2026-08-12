-- Make the backend one-active-session rule atomic. The API performs a
-- friendly preflight for its error message, while this partial unique index
-- closes the concurrent-create race and keeps Telegram/web/mobile behavior
-- identical.

CREATE UNIQUE INDEX dance_attempt_session_one_active_per_subject_idx
ON dance_attempt_sessions (subject_user_id)
WHERE status IN ('initialized', 'uploading', 'submitted', 'grading');
