CREATE TABLE IF NOT EXISTS telegram_onboarding_intents (
    telegram_onboarding_intent_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    telegram_community_bot_id TEXT NOT NULL,
    onboarding_token_hash TEXT NOT NULL,
    telegram_user_id TEXT,
    telegram_private_chat_id TEXT,
    join_grant_id TEXT,
    source TEXT NOT NULL CHECK (
        source IN ('dm', 'join_request')
    ),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'completed', 'expired', 'canceled')
    ),
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (telegram_community_bot_id) REFERENCES telegram_community_bots(telegram_community_bot_id),
    FOREIGN KEY (join_grant_id) REFERENCES telegram_join_grants(grant_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_onboarding_intents_token
    ON telegram_onboarding_intents(onboarding_token_hash);

CREATE INDEX IF NOT EXISTS idx_telegram_onboarding_intents_community
    ON telegram_onboarding_intents(community_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_onboarding_intents_telegram_user
    ON telegram_onboarding_intents(telegram_user_id, status, created_at DESC);

