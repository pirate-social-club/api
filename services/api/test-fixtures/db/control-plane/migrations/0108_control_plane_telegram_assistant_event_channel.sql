ALTER TABLE telegram_assistant_events
    ADD COLUMN channel TEXT NOT NULL DEFAULT 'group'
        CHECK (channel IN ('group', 'private_member', 'private_preview'));

CREATE INDEX IF NOT EXISTS idx_telegram_assistant_events_channel_community
    ON telegram_assistant_events(channel, community_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_assistant_events_channel_user
    ON telegram_assistant_events(channel, telegram_user_id, community_id, created_at DESC);
