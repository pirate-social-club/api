-- Bridges a Telegram-authenticated Mini App session to a separately
-- authenticated Pirate web session without exposing either bearer credential
-- to the other context.
CREATE TABLE IF NOT EXISTS telegram_account_link_intents (
    link_intent_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    source_user_id TEXT NOT NULL REFERENCES users(user_id),
    telegram_user_id TEXT NOT NULL,
    telegram_provider_subject TEXT NOT NULL,
    telegram_community_bot_id TEXT NOT NULL
        REFERENCES telegram_community_bots(telegram_community_bot_id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'consumed', 'expired', 'refused', 'canceled')
    ),
    consumed_by_user_id TEXT REFERENCES users(user_id),
    refusal_code TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reissuing a link from the Mini App replaces, rather than accumulates,
-- pending credentials for the same proven Telegram identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_account_link_intents_active_subject
    ON telegram_account_link_intents(telegram_provider_subject)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_telegram_account_link_intents_expiry
    ON telegram_account_link_intents(status, expires_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_telegram_account_link_intents_source_recent
    ON telegram_account_link_intents(source_user_id, created_at DESC);
