ALTER TABLE hns_import_session_locks
    ADD COLUMN restart_attempt_token TEXT;

ALTER TABLE hns_import_session_locks
    ADD COLUMN restart_challenge_txt_value TEXT;

ALTER TABLE hns_import_session_locks
    ADD COLUMN restart_attempt_expires_at TIMESTAMPTZ;

-- migration-safety: existing-table-check-reviewed: all three new nullable columns are null on existing rows
ALTER TABLE hns_import_session_locks
    ADD CONSTRAINT hns_import_restart_attempt_consistent CHECK (
        (restart_attempt_token IS NULL
            AND restart_challenge_txt_value IS NULL
            AND restart_attempt_expires_at IS NULL)
        OR
        (restart_attempt_token IS NOT NULL
            AND restart_challenge_txt_value IS NOT NULL
            AND restart_attempt_expires_at IS NOT NULL)
    );

CREATE INDEX idx_hns_import_session_locks_restart_attempt_expires_at
    ON hns_import_session_locks(restart_attempt_expires_at)
    WHERE restart_attempt_expires_at IS NOT NULL;
