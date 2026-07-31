-- Server-owned state for study sessions conducted entirely in a sovereign
-- community bot chat. Pirate's community-shard study session remains the
-- learning authority; this table stores only Telegram presentation state.
CREATE TABLE IF NOT EXISTS telegram_chat_study_sessions (
    chat_study_session_id TEXT PRIMARY KEY,
    telegram_community_bot_id TEXT NOT NULL,
    telegram_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT,
    target_language TEXT NOT NULL DEFAULT 'en',
    status TEXT NOT NULL CHECK (
        status IN ('selecting', 'active', 'processing', 'completed', 'canceled', 'failed')
    ),
    action_token TEXT NOT NULL UNIQUE,
    action_kind TEXT NOT NULL CHECK (
        action_kind IN ('select_song', 'answer_choice', 'await_voice', 'none')
    ),
    action_payload_json TEXT NOT NULL DEFAULT '{}',
    study_session_id TEXT,
    current_exercise_id TEXT,
    prompt_message_id BIGINT,
    last_error_code TEXT,
    last_error_message TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (telegram_community_bot_id)
        REFERENCES telegram_community_bots(telegram_community_bot_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_chat_study_sessions_active_bot_user
    ON telegram_chat_study_sessions(telegram_community_bot_id, telegram_user_id)
    WHERE status IN ('selecting', 'active', 'processing');

CREATE INDEX IF NOT EXISTS idx_telegram_chat_study_sessions_expiry
    ON telegram_chat_study_sessions(status, expires_at)
    WHERE status IN ('selecting', 'active', 'processing');

-- Callback query IDs are globally unique and Telegram can redeliver them.
-- The delivery lifecycle permits a failed handler to be retried without ever
-- submitting a successful answer twice.
CREATE TABLE IF NOT EXISTS telegram_chat_study_callback_deliveries (
    callback_query_id TEXT PRIMARY KEY,
    chat_study_session_id TEXT NOT NULL,
    telegram_community_bot_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('processing', 'consumed', 'failed')
    ),
    processing_lease_expires_at TIMESTAMPTZ,
    last_error_message TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (chat_study_session_id)
        REFERENCES telegram_chat_study_sessions(chat_study_session_id),
    FOREIGN KEY (telegram_community_bot_id)
        REFERENCES telegram_community_bots(telegram_community_bot_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_chat_study_callbacks_session
    ON telegram_chat_study_callback_deliveries(chat_study_session_id, received_at DESC);

-- A native voice intent can return to its owning chat study session after
-- grading instead of sending the learner into the Mini App.
ALTER TABLE telegram_study_voice_intents
    ADD COLUMN IF NOT EXISTS chat_study_session_id TEXT;

ALTER TABLE telegram_study_voice_intents
    DROP CONSTRAINT IF EXISTS telegram_study_voice_intents_chat_study_session_id_fkey;

ALTER TABLE telegram_study_voice_intents
    ADD CONSTRAINT telegram_study_voice_intents_chat_study_session_id_fkey
    FOREIGN KEY (chat_study_session_id)
        REFERENCES telegram_chat_study_sessions(chat_study_session_id);

CREATE INDEX IF NOT EXISTS idx_telegram_study_voice_intents_chat_session
    ON telegram_study_voice_intents(chat_study_session_id)
    WHERE chat_study_session_id IS NOT NULL;
