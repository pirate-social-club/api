-- Raw, replayable Ethereum Follow Protocol ingestion state. The graph is
-- global product data, so it belongs in the control plane rather than any
-- community D1 shard.

CREATE TABLE efp_indexer_cursors (
    chain_id BIGINT PRIMARY KEY CHECK (chain_id > 0),
    indexed_through_block BIGINT NOT NULL CHECK (indexed_through_block >= 0),
    indexed_through_block_hash TEXT NOT NULL,
    safe_head_block BIGINT NOT NULL CHECK (safe_head_block >= indexed_through_block),
    last_scan_started_at TIMESTAMPTZ NOT NULL,
    last_scan_completed_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

-- Keep the original op bytes and canonical EVM ordering. Decoded columns are
-- diagnostic/indexing aids only; raw_op is the source for future re-derivation.
CREATE TABLE efp_list_ops (
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    contract_address TEXT NOT NULL,
    slot TEXT NOT NULL,
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index INTEGER NOT NULL CHECK (transaction_index >= 0),
    log_index INTEGER NOT NULL CHECK (log_index >= 0),
    raw_op TEXT NOT NULL,
    op_version INTEGER,
    opcode INTEGER,
    record_version INTEGER,
    record_type INTEGER,
    target_address TEXT,
    tag TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (chain_id, transaction_hash, log_index)
);

CREATE INDEX idx_efp_list_ops_slot_order
    ON efp_list_ops(
        chain_id,
        contract_address,
        slot,
        block_number,
        transaction_index,
        log_index
    );

CREATE INDEX idx_efp_list_ops_target
    ON efp_list_ops(target_address)
    WHERE target_address IS NOT NULL;

-- Account metadata is deployed on Base. Preserve every primary-list pointer
-- change so the authoritative list can be reconstructed at any indexed block.
CREATE TABLE efp_primary_list_events (
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    contract_address TEXT NOT NULL,
    account_address TEXT NOT NULL,
    metadata_key TEXT NOT NULL CHECK (metadata_key = 'primary-list'),
    raw_value TEXT NOT NULL,
    list_id TEXT,
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index INTEGER NOT NULL CHECK (transaction_index >= 0),
    log_index INTEGER NOT NULL CHECK (log_index >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (chain_id, transaction_hash, log_index)
);

CREATE INDEX idx_efp_primary_list_events_account_order
    ON efp_primary_list_events(
        account_address,
        block_number,
        transaction_index,
        log_index
    );

-- Primary metadata points at an EFP List NFT id. Registry history resolves that
-- id to the chain/contract/slot where its operations actually live.
CREATE TABLE efp_list_storage_location_events (
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    registry_address TEXT NOT NULL,
    list_id TEXT NOT NULL,
    raw_storage_location TEXT NOT NULL,
    storage_chain_id BIGINT,
    storage_contract_address TEXT,
    storage_slot TEXT,
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index INTEGER NOT NULL CHECK (transaction_index >= 0),
    log_index INTEGER NOT NULL CHECK (log_index >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (chain_id, transaction_hash, log_index)
);

CREATE INDEX idx_efp_list_storage_location_events_list_order
    ON efp_list_storage_location_events(
        list_id,
        block_number,
        transaction_index,
        log_index
    );
