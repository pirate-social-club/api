-- Admit the two server-derived Telegram delivery modes used by Dance Gate 0B.
-- Existing browser sessions retain their original in_app_camera value.
-- migration-safety: existing-table-check-reviewed: the replacement strictly widens the existing nullable capture_mode domain, so every existing row remains valid.

ALTER TABLE dance_attempt_sessions
    DROP CONSTRAINT dance_attempt_sessions_capture_mode_check,
    ADD CONSTRAINT dance_attempt_sessions_capture_mode_check CHECK (
        capture_mode IS NULL
        OR capture_mode IN (
            'in_app_camera',
            'telegram_video',
            'telegram_document'
        )
    );
