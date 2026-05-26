ALTER TABLE global_handles ADD COLUMN global_handle_paid_quote_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_global_handles_paid_quote
    ON global_handles(global_handle_paid_quote_id)
    WHERE global_handle_paid_quote_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS global_handle_paid_quotes (
    global_handle_paid_quote_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    current_global_handle_id TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('quoted', 'claimed', 'expired', 'failed')
    ),
    tier TEXT NOT NULL CHECK (
        tier IN ('standard', 'premium')
    ),
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    policy_version TEXT NOT NULL,
    pricing_tier TEXT,
    quote_ttl_seconds INTEGER NOT NULL CHECK (quote_ttl_seconds > 0),
    quoted_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    claimed_at TIMESTAMPTZ,
    settlement_wallet_attachment_id TEXT,
    funding_tx_ref TEXT,
    settlement_tx_ref TEXT,
    settings_snapshot_json TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (current_global_handle_id) REFERENCES global_handles(global_handle_id)
);

CREATE INDEX IF NOT EXISTS idx_global_handle_paid_quotes_user_status
    ON global_handle_paid_quotes(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_global_handle_paid_quotes_label_status
    ON global_handle_paid_quotes(label_normalized, status);
