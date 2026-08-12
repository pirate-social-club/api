ALTER TABLE telegram_setup_intents
    ADD COLUMN IF NOT EXISTS setup_kind TEXT NOT NULL DEFAULT 'group' CHECK (
        setup_kind IN ('group', 'channel')
    );

CREATE TABLE IF NOT EXISTS telegram_channel_destinations (
    telegram_channel_destination_id TEXT PRIMARY KEY,
    telegram_community_bot_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    telegram_chat_id TEXT NOT NULL,
    channel_title TEXT NOT NULL,
    channel_username TEXT,
    bot_admin_status TEXT NOT NULL CHECK (
        bot_admin_status IN ('ready', 'missing', 'insufficient_permissions', 'left_chat')
    ),
    publication_mode TEXT NOT NULL DEFAULT 'from_now' CHECK (
        publication_mode IN ('off', 'from_now', 'recent_backfill')
    ),
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'unlinked')
    ),
    linked_by_user_id TEXT NOT NULL,
    setup_intent_id TEXT,
    linked_at TEXT NOT NULL,
    unlinked_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (telegram_community_bot_id) REFERENCES telegram_community_bots(telegram_community_bot_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (linked_by_user_id) REFERENCES users(user_id),
    FOREIGN KEY (setup_intent_id) REFERENCES telegram_setup_intents(telegram_setup_intent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_channel_destinations_active_community
    ON telegram_channel_destinations(community_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_channel_destinations_active_chat
    ON telegram_channel_destinations(telegram_chat_id)
    WHERE status = 'active';

CREATE TABLE IF NOT EXISTS telegram_post_deliveries (
    telegram_post_delivery_id TEXT PRIMARY KEY,
    telegram_channel_destination_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    telegram_chat_id TEXT NOT NULL,
    telegram_message_id INTEGER,
    projection_updated_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'delivered', 'failed', 'deleted')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (telegram_channel_destination_id)
        REFERENCES telegram_channel_destinations(telegram_channel_destination_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_post_deliveries_destination_post
    ON telegram_post_deliveries(telegram_channel_destination_id, post_id);

CREATE INDEX IF NOT EXISTS idx_telegram_post_deliveries_retry
    ON telegram_post_deliveries(status, updated_at)
    WHERE status IN ('pending', 'failed');
