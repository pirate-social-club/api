CREATE TABLE IF NOT EXISTS telegram_community_bots (
    telegram_community_bot_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    encrypted_bot_token TEXT NOT NULL,
    token_last4 TEXT NOT NULL,
    encryption_key_version INTEGER NOT NULL DEFAULT 1 CHECK (
        encryption_key_version > 0
    ),
    telegram_bot_user_id TEXT NOT NULL,
    bot_username TEXT NOT NULL,
    bot_display_name TEXT NOT NULL,
    webhook_id TEXT NOT NULL UNIQUE,
    webhook_secret TEXT NOT NULL,
    webhook_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        webhook_status IN ('pending', 'active', 'failed', 'disabled')
    ),
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'revoked', 'invalid')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    rotated_from TEXT,
    actor_user_id TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (rotated_from) REFERENCES telegram_community_bots(telegram_community_bot_id),
    FOREIGN KEY (actor_user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_community_bots_active
    ON telegram_community_bots(community_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_telegram_community_bots_webhook
    ON telegram_community_bots(webhook_id, status);

ALTER TABLE telegram_setup_intents
    ADD COLUMN IF NOT EXISTS telegram_community_bot_id TEXT;

ALTER TABLE telegram_linked_chats
    ADD COLUMN IF NOT EXISTS telegram_community_bot_id TEXT;

CREATE INDEX IF NOT EXISTS idx_telegram_setup_intents_bot
    ON telegram_setup_intents(telegram_community_bot_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_linked_chats_bot
    ON telegram_linked_chats(telegram_community_bot_id, status, linked_at DESC);
