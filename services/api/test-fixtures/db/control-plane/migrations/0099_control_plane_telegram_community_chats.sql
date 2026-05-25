CREATE TABLE IF NOT EXISTS telegram_setup_intents (
    telegram_setup_intent_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    setup_token_hash TEXT NOT NULL,
    requested_permissions_json TEXT,
    request_id INTEGER,
    request_owner_telegram_user_id TEXT,
    request_private_chat_id TEXT,
    request_message_id INTEGER,
    request_sent_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'completed', 'expired', 'canceled')
    ),
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    telegram_user_id TEXT,
    telegram_chat_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_setup_intents_token
    ON telegram_setup_intents(setup_token_hash);

CREATE INDEX IF NOT EXISTS idx_telegram_setup_intents_community
    ON telegram_setup_intents(community_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_setup_intents_expiry
    ON telegram_setup_intents(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_telegram_setup_intents_request
    ON telegram_setup_intents(request_id, request_owner_telegram_user_id, status)
    WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS telegram_linked_chats (
    telegram_linked_chat_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    telegram_chat_id TEXT NOT NULL,
    chat_title TEXT NOT NULL,
    chat_username TEXT,
    chat_type TEXT NOT NULL CHECK (
        chat_type IN ('group', 'supergroup')
    ),
    link_mode TEXT NOT NULL DEFAULT 'join_request' CHECK (
        link_mode IN ('invite_link', 'join_request')
    ),
    bot_admin_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
        bot_admin_status IN ('unknown', 'ready', 'missing', 'insufficient_permissions', 'left_chat')
    ),
    bot_permissions_json TEXT,
    directory_visible INTEGER NOT NULL DEFAULT 1 CHECK (
        directory_visible IN (0, 1)
    ),
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'unlinked')
    ),
    linked_by_user_id TEXT NOT NULL,
    setup_intent_id TEXT,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unlinked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (linked_by_user_id) REFERENCES users(user_id),
    FOREIGN KEY (setup_intent_id) REFERENCES telegram_setup_intents(telegram_setup_intent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_linked_chats_active_community
    ON telegram_linked_chats(community_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_linked_chats_active_chat
    ON telegram_linked_chats(telegram_chat_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_telegram_linked_chats_directory
    ON telegram_linked_chats(directory_visible, status, linked_at DESC)
    WHERE status = 'active';

CREATE TABLE IF NOT EXISTS telegram_accounts (
    telegram_user_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    photo_url TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_accounts_user
    ON telegram_accounts(user_id);

CREATE TABLE IF NOT EXISTS telegram_join_grants (
    grant_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    telegram_chat_id TEXT NOT NULL,
    telegram_user_id TEXT NOT NULL,
    telegram_user_chat_id TEXT,
    user_id TEXT,
    link_mode TEXT NOT NULL CHECK (
        link_mode IN ('invite_link', 'join_request')
    ),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'approved', 'denied', 'expired', 'failed')
    ),
    missing_capabilities_json TEXT,
    join_request_date TIMESTAMPTZ NOT NULL,
    prompted_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_join_grants_chat_user
    ON telegram_join_grants(telegram_chat_id, telegram_user_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_join_grants_pending_chat_user
    ON telegram_join_grants(telegram_chat_id, telegram_user_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_telegram_join_grants_community_status
    ON telegram_join_grants(community_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_join_grants_expiry
    ON telegram_join_grants(status, expires_at);

CREATE TABLE IF NOT EXISTS telegram_assistant_events (
    event_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    telegram_chat_id TEXT NOT NULL,
    telegram_message_id INTEGER NOT NULL,
    telegram_user_id TEXT,
    user_id TEXT,
    trigger_type TEXT NOT NULL CHECK (
        trigger_type IN ('ask_command', 'ask_command_mention', 'reply_to_bot')
    ),
    prompt TEXT NOT NULL,
    assistant_message_ref TEXT,
    status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN ('received', 'ignored', 'answered', 'failed', 'rate_limited')
    ),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_assistant_events_community
    ON telegram_assistant_events(community_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_assistant_events_chat
    ON telegram_assistant_events(telegram_chat_id, telegram_message_id);
