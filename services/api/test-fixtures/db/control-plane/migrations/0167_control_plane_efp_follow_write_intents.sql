-- Durable admission and reconciliation state for server-mediated EFP writes.
-- The API prepares an exact transaction set; the sponsorship relay may execute
-- only those transactions and consumes the reserved daily budget atomically.

CREATE TABLE efp_follow_write_intents (
    follow_write_intent_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    actor_user_id TEXT NOT NULL REFERENCES users(user_id),
    actor_wallet_address TEXT NOT NULL CHECK (actor_wallet_address = lower(actor_wallet_address)),
    target_user_id TEXT NOT NULL REFERENCES users(user_id),
    target_wallet_address TEXT NOT NULL CHECK (target_wallet_address = lower(target_wallet_address)),
    desired_following INTEGER NOT NULL CHECK (desired_following IN (0, 1)),
    primary_list_resolution TEXT NOT NULL CHECK (primary_list_resolution IN ('none', 'found')),
    list_chain_id BIGINT NOT NULL CHECK (list_chain_id > 0),
    list_slot TEXT NOT NULL,
    prepared_transactions_json JSONB NOT NULL,
    prepared_transaction_count INTEGER NOT NULL CHECK (prepared_transaction_count BETWEEN 0 AND 2),
    sponsorship_reserved_transaction_count INTEGER NOT NULL DEFAULT 0 CHECK (
        sponsorship_reserved_transaction_count >= 0
        AND sponsorship_reserved_transaction_count <= prepared_transaction_count
    ),
    sponsored_transaction_count INTEGER NOT NULL DEFAULT 0 CHECK (
        sponsored_transaction_count >= 0
        AND sponsored_transaction_count <= prepared_transaction_count
    ),
    status TEXT NOT NULL CHECK (
        status IN ('prepared', 'submitting', 'submitted', 'confirmed', 'reflected', 'expired', 'failed')
    ),
    transaction_hashes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    expires_at TIMESTAMPTZ NOT NULL,
    submitted_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    reflected_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (actor_user_id, idempotency_key),
    CONSTRAINT efp_follow_write_intent_not_self
        CHECK (actor_user_id <> target_user_id)
);

CREATE INDEX idx_efp_follow_write_intents_pending_reflection
    ON efp_follow_write_intents(status, updated_at)
    WHERE status IN ('submitted', 'confirmed');

CREATE INDEX idx_efp_follow_write_intents_actor_recent
    ON efp_follow_write_intents(actor_user_id, created_at DESC);

-- One row per UTC day. Reservations and completed sends both count toward the
-- fail-closed ceiling so concurrent requests cannot oversubscribe sponsorship.
CREATE TABLE efp_follow_sponsorship_daily_budgets (
    budget_date DATE PRIMARY KEY,
    transaction_limit INTEGER NOT NULL CHECK (transaction_limit > 0),
    reserved_transactions INTEGER NOT NULL DEFAULT 0 CHECK (reserved_transactions >= 0),
    consumed_transactions INTEGER NOT NULL DEFAULT 0 CHECK (consumed_transactions >= 0),
    estimated_usd_micros_per_transaction BIGINT NOT NULL CHECK (estimated_usd_micros_per_transaction > 0),
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT efp_follow_sponsorship_budget_within_limit
        CHECK (reserved_transactions + consumed_transactions <= transaction_limit)
);

-- A confirmed write enqueues both wallets so the projection can deliberately
-- reconcile the affected relationship and counts.
CREATE TABLE efp_follow_reconciliation_queue (
    wallet_address TEXT PRIMARY KEY CHECK (wallet_address = lower(wallet_address)),
    requested_by_follow_write_intent_id TEXT NOT NULL
        REFERENCES efp_follow_write_intents(follow_write_intent_id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    requested_at TIMESTAMPTZ NOT NULL,
    available_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_efp_follow_reconciliation_queue_pending
    ON efp_follow_reconciliation_queue(status, available_at, wallet_address);

-- Daily snapshots make the Slice 4 outcome measurable: Pirate wallets present
-- in the graph and effective edges created by those wallets. Weekly reporting
-- reads this table rather than reconstructing historical adoption.
CREATE TABLE efp_follow_adoption_daily (
    snapshot_date DATE PRIMARY KEY,
    attached_wallets_in_graph BIGINT NOT NULL CHECK (attached_wallets_in_graph >= 0),
    edges_by_attached_wallets BIGINT NOT NULL CHECK (edges_by_attached_wallets >= 0),
    captured_at TIMESTAMPTZ NOT NULL
);
