-- Global observation ledger for inbound ERC-20 funding. Buyer-submitted hashes
-- may seed observation, but settlement consumers claim canonical log events from
-- this table rather than treating a client assertion as payment evidence.
CREATE TABLE observed_funding_receipts (
    observed_funding_receipt_id TEXT PRIMARY KEY,
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
    tx_hash TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    log_index INTEGER NOT NULL CHECK (log_index >= 0),
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    sender_address TEXT NOT NULL CHECK (sender_address ~ '^0x[0-9a-f]{40}$'),
    recipient_address TEXT NOT NULL CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
    amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
    observed_source TEXT NOT NULL CHECK (observed_source IN ('indexer', 'buyer_hint', 'operator_reconcile')),
    finality_status TEXT NOT NULL CHECK (finality_status IN ('observed', 'canonical', 'orphaned')),
    match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK (
        match_status IN ('unmatched', 'claimed', 'refund_review', 'refunded', 'ignored')
    ),
    consumer_rail TEXT,
    consumer_id TEXT,
    quote_id TEXT,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    canonical_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain_id, token_address, tx_hash, log_index),
    CHECK (
        (match_status = 'claimed' AND consumer_rail IS NOT NULL AND consumer_id IS NOT NULL AND claimed_at IS NOT NULL)
        OR (match_status <> 'claimed')
    )
);

CREATE UNIQUE INDEX observed_funding_receipts_consumer_unique
    ON observed_funding_receipts (consumer_rail, consumer_id)
    WHERE consumer_rail IS NOT NULL AND consumer_id IS NOT NULL;

CREATE INDEX observed_funding_receipts_unmatched_idx
    ON observed_funding_receipts (recipient_address, observed_at, observed_funding_receipt_id)
    WHERE match_status = 'unmatched' AND finality_status = 'canonical';

CREATE INDEX observed_funding_receipts_tx_idx
    ON observed_funding_receipts (chain_id, tx_hash);
