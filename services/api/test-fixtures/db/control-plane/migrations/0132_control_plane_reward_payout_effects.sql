-- Rewards-shaped payout ledger.
--
-- Credits stay in reward_events. Cashout effects live here as the idempotent
-- debit/settlement ledger for user reward withdrawals. Recipient address is
-- snapshotted when the cashout effect is created and is never re-resolved from wallet state.

CREATE TABLE reward_payout_effects (
    reward_payout_effect_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    recipient_address TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed')),
    settlement_ref TEXT,
    failure_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    signed_tx TEXT,
    broadcast_nonce INTEGER,
    coordinator_ref TEXT,
    coordinator_state TEXT,
    submitted_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX reward_payout_effects_idempotency_unique
    ON reward_payout_effects (user_id, idempotency_key);

CREATE INDEX reward_payout_effects_user_created_idx
    ON reward_payout_effects (user_id, created_at DESC);

CREATE INDEX reward_payout_effects_user_status_idx
    ON reward_payout_effects (user_id, status, updated_at DESC);

CREATE INDEX reward_payout_effects_status_updated_idx
    ON reward_payout_effects (status, updated_at ASC, reward_payout_effect_id ASC);
