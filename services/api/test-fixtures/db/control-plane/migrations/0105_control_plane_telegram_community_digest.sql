ALTER TABLE telegram_linked_chats
    ADD COLUMN IF NOT EXISTS announcement_mode TEXT NOT NULL DEFAULT 'manual' CHECK (
        announcement_mode IN ('off', 'manual', 'hot')
    );

CREATE TABLE IF NOT EXISTS telegram_community_digest_messages (
    telegram_community_digest_message_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    telegram_linked_chat_id TEXT,
    telegram_chat_id TEXT NOT NULL,
    message_thread_id INTEGER,
    telegram_message_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'deleted', 'failed')
    ),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (telegram_linked_chat_id) REFERENCES telegram_linked_chats(telegram_linked_chat_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_community_digest_active
    ON telegram_community_digest_messages(community_id, telegram_linked_chat_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_telegram_community_digest_chat_message
    ON telegram_community_digest_messages(telegram_chat_id, message_thread_id, telegram_message_id);
