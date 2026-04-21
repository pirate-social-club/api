CREATE TABLE wallet_attachment_provider_state (
    wallet_attachment_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_wallet_id TEXT NOT NULL,
    provider_chain_type TEXT NOT NULL,
    public_key_hex TEXT NOT NULL,
    external_wallet_ref TEXT,
    metadata_json JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (wallet_attachment_id) REFERENCES wallet_attachments(wallet_attachment_id)
);

CREATE UNIQUE INDEX idx_wallet_attachment_provider_state_wallet
    ON wallet_attachment_provider_state(provider, provider_wallet_id);
