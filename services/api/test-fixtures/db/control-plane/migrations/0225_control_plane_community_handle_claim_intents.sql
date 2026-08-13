-- Durable control-plane ledger for paid community-handle claims. This migration
-- is dark infrastructure: the existing quote/claim routes do not admit intents
-- until the spike's state-machine and custody readiness gates are enabled.

ALTER TABLE observed_funding_receipts
    ADD COLUMN block_timestamp BIGINT CHECK (block_timestamp IS NULL OR block_timestamp > 0);

CREATE TABLE community_handle_claim_intents (
    community_handle_claim_intent_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    namespace_normalized_label TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    label_display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN (
            'awaiting_authorization',
            'authorized',
            'funded_pending_finalization',
            'completed',
            'refund_pending',
            'refunded'
        )
    ),
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    pricing_model TEXT,
    pricing_tier TEXT,
    settlement_wallet_attachment_id TEXT,
    protocol_owner_wallet_attachment_id TEXT,
    protocol_owner_script_pubkey_hex TEXT,
    protocol_issuance_required BOOLEAN NOT NULL DEFAULT FALSE,
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    chain_id BIGINT CHECK (chain_id IS NULL OR chain_id > 0),
    token_address TEXT CHECK (token_address IS NULL OR token_address ~ '^0x[0-9a-f]{40}$'),
    funding_destination_address TEXT CHECK (funding_destination_address IS NULL OR funding_destination_address ~ '^0x[0-9a-f]{40}$'),
    custody_account_id TEXT,
    custody_key_epoch TEXT,
    latest_quote_id TEXT,
    action_authorization_id TEXT,
    observed_funding_receipt_id TEXT UNIQUE,
    funding_tx_hash TEXT CHECK (funding_tx_hash IS NULL OR funding_tx_hash ~ '^0x[0-9a-f]{64}$'),
    payment_not_after TIMESTAMPTZ NOT NULL,
    funded_at TIMESTAMPTZ,
    finalization_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (finalization_attempt_count >= 0),
    finalization_last_error TEXT,
    finalization_next_attempt_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    refund_pending_at TIMESTAMPTZ,
    refund_reason TEXT,
    refund_coordinator_ref TEXT,
    refund_coordinator_state TEXT,
    refund_tx_hash TEXT CHECK (refund_tx_hash IS NULL OR refund_tx_hash ~ '^0x[0-9a-f]{64}$'),
    refund_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (refund_attempt_count >= 0),
    refund_last_error TEXT,
    refunded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (observed_funding_receipt_id)
        REFERENCES observed_funding_receipts(observed_funding_receipt_id),
    CHECK (
        price_cents = 0 OR (
            chain_id IS NOT NULL AND token_address IS NOT NULL
            AND funding_destination_address IS NOT NULL
            AND custody_account_id IS NOT NULL AND custody_key_epoch IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX community_handle_claim_intents_quote_idx
    ON community_handle_claim_intents (community_id, latest_quote_id)
    WHERE latest_quote_id IS NOT NULL;

CREATE INDEX community_handle_claim_intents_pending_finalization_idx
    ON community_handle_claim_intents (finalization_next_attempt_at, updated_at, community_handle_claim_intent_id)
    WHERE status = 'funded_pending_finalization';

CREATE INDEX community_handle_claim_intents_refund_pending_idx
    ON community_handle_claim_intents (updated_at, community_handle_claim_intent_id)
    WHERE status = 'refund_pending';

CREATE TABLE community_handle_action_authorizations (
    community_handle_action_authorization_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope = 'namespace_handle_claim'),
    actor_user_id TEXT NOT NULL,
    community_handle_claim_intent_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    label_normalized TEXT NOT NULL,
    policy_source TEXT NOT NULL,
    policy_revision BIGINT NOT NULL CHECK (policy_revision >= 1),
    policy_digest TEXT NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
    satisfied_branch_json JSONB NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    payment_not_after TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_by_intent_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (community_handle_claim_intent_id)
        REFERENCES community_handle_claim_intents(community_handle_claim_intent_id),
    CHECK (
        (consumed_at IS NULL AND consumed_by_intent_id IS NULL)
        OR (consumed_at IS NOT NULL AND consumed_by_intent_id = community_handle_claim_intent_id)
    )
);

CREATE UNIQUE INDEX community_handle_action_authorizations_active_intent_idx
    ON community_handle_action_authorizations (community_handle_claim_intent_id)
    WHERE consumed_at IS NULL;

ALTER TABLE community_handle_claim_intents
    ADD CONSTRAINT community_handle_claim_intents_authorization_fk
    FOREIGN KEY (action_authorization_id)
    REFERENCES community_handle_action_authorizations(community_handle_action_authorization_id);

CREATE TABLE community_handle_token_allocations (
    community_handle_token_allocation_id TEXT PRIMARY KEY,
    community_handle_action_authorization_id TEXT NOT NULL,
    community_handle_claim_intent_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    chain_namespace TEXT NOT NULL,
    contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
    token_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
    reserved_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (community_handle_action_authorization_id)
        REFERENCES community_handle_action_authorizations(community_handle_action_authorization_id),
    FOREIGN KEY (community_handle_claim_intent_id)
        REFERENCES community_handle_claim_intents(community_handle_claim_intent_id)
);

CREATE UNIQUE INDEX community_handle_token_allocations_entitlement_idx
    ON community_handle_token_allocations (namespace_id, chain_namespace, contract_address, token_id)
    WHERE status IN ('reserved', 'consumed');
