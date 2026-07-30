-- Telegram has no send idempotency key. Record the prompt handoff separately
-- from the voice-attempt lifecycle so a timed-out Bot API call is never
-- retried as though Telegram definitely did not receive it.
ALTER TABLE telegram_study_voice_intents
    ADD COLUMN IF NOT EXISTS prompt_delivery_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE telegram_study_voice_intents
    ADD COLUMN IF NOT EXISTS prompt_sent_at TIMESTAMPTZ;

ALTER TABLE telegram_study_voice_intents
    DROP CONSTRAINT IF EXISTS telegram_study_voice_intents_prompt_delivery_status_check;

ALTER TABLE telegram_study_voice_intents
    ADD CONSTRAINT telegram_study_voice_intents_prompt_delivery_status_check
    CHECK (
        prompt_delivery_status IN (
            'pending',
            'sending',
            'sent',
            'failed',
            'uncertain'
        )
    );

CREATE INDEX IF NOT EXISTS idx_telegram_study_voice_intents_uncertain_prompt
    ON telegram_study_voice_intents(updated_at)
    WHERE prompt_delivery_status = 'uncertain';
