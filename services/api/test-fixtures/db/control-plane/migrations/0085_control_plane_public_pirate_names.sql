CREATE TABLE IF NOT EXISTS pirate_name_quotes (
    pirate_name_quote_id TEXT PRIMARY KEY,
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('quoted', 'claimed', 'expired', 'failed')
    ),
    buyer_kind TEXT NOT NULL DEFAULT 'wallet' CHECK (buyer_kind = 'wallet'),
    buyer_wallet_address_normalized TEXT NOT NULL,
    chain_ref TEXT NOT NULL DEFAULT 'eip155:84532',
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    policy_version TEXT NOT NULL,
    quote_ttl_seconds INTEGER NOT NULL CHECK (quote_ttl_seconds > 0),
    quoted_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    claimed_at TIMESTAMPTZ,
    funding_tx_ref TEXT,
    settlement_tx_ref TEXT,
    settings_snapshot_json TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pirate_name_quotes_wallet_status
    ON pirate_name_quotes(buyer_wallet_address_normalized, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pirate_name_quotes_active_label
    ON pirate_name_quotes(label_normalized)
    WHERE status IN ('quoted', 'claimed');

CREATE TABLE IF NOT EXISTS pirate_name_registrations (
    pirate_name_registration_id TEXT PRIMARY KEY,
    pirate_name_quote_id TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('active', 'expired', 'revoked')
    ),
    owner_kind TEXT NOT NULL DEFAULT 'wallet' CHECK (owner_kind = 'wallet'),
    owner_wallet_address_normalized TEXT NOT NULL,
    chain_ref TEXT NOT NULL DEFAULT 'eip155:84532',
    price_paid_cents INTEGER NOT NULL CHECK (price_paid_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    pirate_user_id TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (pirate_name_quote_id) REFERENCES pirate_name_quotes(pirate_name_quote_id),
    FOREIGN KEY (pirate_user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pirate_name_registrations_active_label
    ON pirate_name_registrations(label_normalized)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_pirate_name_registrations_wallet_status
    ON pirate_name_registrations(owner_wallet_address_normalized, status, created_at DESC);
