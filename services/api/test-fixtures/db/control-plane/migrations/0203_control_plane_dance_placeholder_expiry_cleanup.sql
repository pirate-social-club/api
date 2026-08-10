-- Placeholder attempt keys never name uploaded media. Permit expiry to avoid
-- enqueueing a delete for those synthetic keys.

ALTER TABLE dance_attempt_sessions
    DROP CONSTRAINT dance_attempt_session_cleanup_check;

-- migration-safety: existing-table-check-reviewed: widens only the not_required branch to expired sessions; all existing rows remain valid
ALTER TABLE dance_attempt_sessions
    ADD CONSTRAINT dance_attempt_session_cleanup_check CHECK (
      (
        cleanup_status = 'not_required'
        AND cleanup_attempt_count = 0
        AND cleanup_next_attempt_at IS NULL
        AND deleted_at IS NULL
        AND status IN ('initialized', 'uploading', 'expired', 'cancelled')
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
