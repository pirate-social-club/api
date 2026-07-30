-- Correlates a say-it-back exercise selected in a community Mini App with the
-- learner's next native Telegram voice message to that same community bot.
--
-- The study attempt coordinates are frozen when the intent is created. This
-- lets webhook processing reuse one idempotency key across redelivered updates
-- and prevents client-supplied session state from reaching the grading write.
CREATE TABLE IF NOT EXISTS telegram_study_voice_intents (
    intent_id TEXT PRIMARY KEY,
    telegram_community_bot_id TEXT NOT NULL,
    telegram_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    exercise_type TEXT NOT NULL DEFAULT 'say_it_back' CHECK (
        exercise_type = 'say_it_back'
    ),
    target_language TEXT NOT NULL,
    study_session_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    presentation_number INTEGER NOT NULL CHECK (presentation_number > 0),
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'consumed', 'failed', 'expired', 'canceled')
    ),
    prompt_message_id BIGINT,
    telegram_voice_message_id BIGINT,
    telegram_voice_file_id TEXT,
    telegram_voice_file_unique_id TEXT,
    processing_lease_id TEXT,
    processing_lease_expires_at TIMESTAMPTZ,
    processing_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
        processing_attempt_count >= 0
    ),
    last_error_code TEXT,
    last_error_message TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (telegram_community_bot_id)
        REFERENCES telegram_community_bots(telegram_community_bot_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    UNIQUE (idempotency_key)
);

-- A learner may have one pending exercise per sovereign community bot. Intents
-- for different bots coexist without cross-wiring their webhook deliveries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_study_voice_intents_active_bot_user
    ON telegram_study_voice_intents(telegram_community_bot_id, telegram_user_id)
    WHERE status IN ('pending', 'processing');

-- Telegram may redeliver the same update. Either identifier is sufficient to
-- recognize a voice message already claimed for this bot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_study_voice_intents_bot_voice_file
    ON telegram_study_voice_intents(
        telegram_community_bot_id,
        telegram_voice_file_unique_id
    )
    WHERE telegram_voice_file_unique_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_study_voice_intents_bot_user_message
    ON telegram_study_voice_intents(
        telegram_community_bot_id,
        telegram_user_id,
        telegram_voice_message_id
    )
    WHERE telegram_voice_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_study_voice_intents_pending_lookup
    ON telegram_study_voice_intents(
        telegram_community_bot_id,
        telegram_user_id,
        status,
        created_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_telegram_study_voice_intents_expiry
    ON telegram_study_voice_intents(status, expires_at)
    WHERE status IN ('pending', 'processing');
