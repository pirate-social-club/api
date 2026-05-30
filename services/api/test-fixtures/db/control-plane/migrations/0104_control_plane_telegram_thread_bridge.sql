CREATE TABLE IF NOT EXISTS telegram_content_messages (
    telegram_content_message_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    telegram_linked_chat_id TEXT,
    telegram_chat_id TEXT NOT NULL,
    message_thread_id INTEGER,
    telegram_message_id INTEGER NOT NULL,
    target_type TEXT NOT NULL CHECK (
        target_type IN ('post', 'comment')
    ),
    target_id TEXT NOT NULL,
    thread_root_post_id TEXT NOT NULL,
    author_telegram_user_id TEXT,
    author_user_id TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'deleted', 'failed')
    ),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (telegram_linked_chat_id) REFERENCES telegram_linked_chats(telegram_linked_chat_id),
    FOREIGN KEY (author_user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_content_messages_topic_message
    ON telegram_content_messages(telegram_chat_id, message_thread_id, telegram_message_id)
    WHERE message_thread_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_content_messages_chat_message
    ON telegram_content_messages(telegram_chat_id, telegram_message_id)
    WHERE message_thread_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_content_messages_target
    ON telegram_content_messages(target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_telegram_content_messages_thread_root
    ON telegram_content_messages(thread_root_post_id, status);

CREATE INDEX IF NOT EXISTS idx_telegram_content_messages_chat_thread
    ON telegram_content_messages(telegram_chat_id, message_thread_id, status);

CREATE TABLE IF NOT EXISTS telegram_participation_prompts (
    telegram_participation_prompt_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    telegram_user_id TEXT NOT NULL,
    user_id TEXT,
    prompt_kind TEXT NOT NULL CHECK (
        prompt_kind IN ('link_required', 'verification_required')
    ),
    last_prompted_at TEXT NOT NULL,
    prompt_count INTEGER NOT NULL DEFAULT 1 CHECK (
        prompt_count >= 0
    ),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_participation_prompts_unique
    ON telegram_participation_prompts(community_id, telegram_user_id, prompt_kind);

CREATE INDEX IF NOT EXISTS idx_telegram_participation_prompts_user
    ON telegram_participation_prompts(user_id, community_id)
    WHERE user_id IS NOT NULL;
