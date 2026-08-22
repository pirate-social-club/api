-- Persist the Telegram identity and prompt facts that authorize one Dance Gate 0B upload.
-- Existing API-created sessions remain source_channel = 'api' with no Telegram metadata.
-- migration-safety: existing-table-check-reviewed: new columns backfill to the API envelope and the constraint accepts every pre-migration row.

ALTER TABLE dance_attempt_sessions
    ADD COLUMN source_channel TEXT NOT NULL DEFAULT 'api' CHECK (
        source_channel IN ('api', 'telegram')
    ),
    ADD COLUMN telegram_bot_user_id TEXT,
    ADD COLUMN telegram_chat_id TEXT,
    ADD COLUMN telegram_sender_id TEXT,
    ADD COLUMN telegram_prompt_message_id BIGINT,
    ADD COLUMN telegram_file_id TEXT,
    ADD COLUMN telegram_file_unique_id TEXT,
    ADD COLUMN telegram_delivery_mode TEXT CHECK (
        telegram_delivery_mode IS NULL
        OR telegram_delivery_mode IN ('video', 'document')
    ),
    ADD CONSTRAINT dance_attempt_session_telegram_binding_check CHECK (
        (
            source_channel = 'api'
            AND telegram_bot_user_id IS NULL
            AND telegram_chat_id IS NULL
            AND telegram_sender_id IS NULL
            AND telegram_prompt_message_id IS NULL
            AND telegram_file_id IS NULL
            AND telegram_file_unique_id IS NULL
            AND telegram_delivery_mode IS NULL
            AND (capture_mode IS NULL OR capture_mode = 'in_app_camera')
        )
        OR
        (
            source_channel = 'telegram'
            AND telegram_bot_user_id IS NOT NULL
            AND telegram_chat_id IS NOT NULL
            AND telegram_sender_id IS NOT NULL
            AND (
                telegram_prompt_message_id IS NOT NULL
                OR status = 'initialized'
            )
            AND (
                (
                    telegram_file_id IS NULL
                    AND telegram_file_unique_id IS NULL
                    AND telegram_delivery_mode IS NULL
                    AND capture_mode IS NULL
                )
                OR
                (
                    telegram_file_id IS NOT NULL
                    AND telegram_file_unique_id IS NOT NULL
                    AND telegram_delivery_mode IS NOT NULL
                    AND capture_mode = 'telegram_' || telegram_delivery_mode
                )
            )
        )
    );

CREATE UNIQUE INDEX dance_attempt_sessions_one_active_telegram_sender
ON dance_attempt_sessions (telegram_bot_user_id, telegram_chat_id, telegram_sender_id)
WHERE source_channel = 'telegram'
  AND status IN ('initialized', 'uploading', 'submitted', 'grading');

CREATE UNIQUE INDEX dance_attempt_sessions_telegram_prompt
ON dance_attempt_sessions (telegram_bot_user_id, telegram_chat_id, telegram_prompt_message_id)
WHERE source_channel = 'telegram'
  AND telegram_prompt_message_id IS NOT NULL;
