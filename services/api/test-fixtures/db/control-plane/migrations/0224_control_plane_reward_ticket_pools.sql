-- Daily Megapot ticket pools attached to songs.
--
-- Ticket pools are parallel to Study/Karaoke cash campaigns. Funders' USDC
-- purchases tickets; claimed Megapot USDC is a separate beneficiary liability.
-- Atomic amounts use NUMERIC(78, 0), which covers the full uint256 range while
-- keeping arithmetic exact and serializable as decimal strings at API edges.

CREATE TABLE reward_ticket_pools (
    reward_ticket_pool_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(community_id),
    post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT NOT NULL,
    creator_user_id TEXT NOT NULL REFERENCES users(user_id),
    song_owner_user_id TEXT NOT NULL REFERENCES users(user_id),
    creation_idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'draft', 'funding_quoted', 'funding_confirming', 'scheduled', 'active',
        'paused', 'exhausted', 'operational_hold', 'ended', 'canceled'
    )),
    qualifying_activity TEXT NOT NULL CHECK (qualifying_activity IN ('karaoke', 'either')),
    minimum_score_bps INTEGER CHECK (
        minimum_score_bps IS NULL OR minimum_score_bps BETWEEN 0 AND 10000
    ),
    identity_policy_version TEXT NOT NULL,
    tickets_per_drawing INTEGER NOT NULL CHECK (tickets_per_drawing > 0),
    max_ticket_cents INTEGER NOT NULL CHECK (max_ticket_cents > 0),
    entry_cutoff_seconds INTEGER NOT NULL CHECK (entry_cutoff_seconds > 0),
    drawing_association_policy TEXT NOT NULL,
    beneficiary_algorithm_version TEXT NOT NULL CHECK (
        beneficiary_algorithm_version = 'equal_v1'
    ),
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    jackpot_address TEXT NOT NULL CHECK (jackpot_address ~ '^0x[0-9a-fA-F]{40}$'),
    random_ticket_buyer_address TEXT NOT NULL
        CHECK (random_ticket_buyer_address ~ '^0x[0-9a-fA-F]{40}$'),
    ticket_nft_address TEXT NOT NULL CHECK (ticket_nft_address ~ '^0x[0-9a-fA-F]{40}$'),
    usdc_token_address TEXT NOT NULL CHECK (usdc_token_address ~ '^0x[0-9a-fA-F]{40}$'),
    custody_address TEXT NOT NULL CHECK (custody_address ~ '^0x[0-9a-fA-F]{40}$'),
    referrer_address TEXT CHECK (
        referrer_address IS NULL OR referrer_address ~ '^0x[0-9a-fA-F]{40}$'
    ),
    source_tag TEXT NOT NULL CHECK (octet_length(source_tag) <= 32),
    terms_version INTEGER NOT NULL DEFAULT 1 CHECK (terms_version > 0),
    terms_hash TEXT NOT NULL CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
    funded_cents BIGINT NOT NULL DEFAULT 0 CHECK (funded_cents >= 0),
    reserved_cents BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
    fulfilled_cents BIGINT NOT NULL DEFAULT 0 CHECK (fulfilled_cents >= 0),
    refunded_cents BIGINT NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    exhausted_at TIMESTAMPTZ,
    operational_held_at TIMESTAMPTZ,
    operational_hold_reason TEXT,
    ended_at TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (creator_user_id, creation_idempotency_key),
    CONSTRAINT reward_ticket_pools_schedule_check CHECK (ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT reward_ticket_pools_budget_conservation_check CHECK (
        reserved_cents + fulfilled_cents + refunded_cents <= funded_cents
    ),
    CONSTRAINT reward_ticket_pools_operational_hold_shape_check CHECK (
        (status = 'operational_hold' AND operational_held_at IS NOT NULL AND operational_hold_reason IS NOT NULL)
        OR (status <> 'operational_hold')
    )
);

CREATE UNIQUE INDEX reward_ticket_pools_one_non_terminal_per_song
    ON reward_ticket_pools (community_id, post_id)
    WHERE status NOT IN ('ended', 'canceled');

CREATE INDEX reward_ticket_pools_discovery_idx
    ON reward_ticket_pools (status, community_id, updated_at DESC, reward_ticket_pool_id)
    WHERE status NOT IN ('ended', 'canceled');

CREATE TABLE reward_ticket_pool_funding_effects (
    reward_ticket_pool_funding_effect_id TEXT PRIMARY KEY,
    reward_ticket_pool_id TEXT NOT NULL
        REFERENCES reward_ticket_pools(reward_ticket_pool_id),
    funder_user_id TEXT NOT NULL REFERENCES users(user_id),
    idempotency_key TEXT NOT NULL,
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-fA-F]{40}$'),
    expected_amount_cents BIGINT NOT NULL CHECK (expected_amount_cents > 0),
    expected_amount_atomic NUMERIC(78, 0) NOT NULL CHECK (expected_amount_atomic > 0),
    received_amount_atomic NUMERIC(78, 0) CHECK (received_amount_atomic > 0),
    sender_address TEXT NOT NULL CHECK (sender_address ~ '^0x[0-9a-fA-F]{40}$'),
    treasury_address TEXT NOT NULL CHECK (treasury_address ~ '^0x[0-9a-fA-F]{40}$'),
    tx_hash TEXT CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    log_index INTEGER CHECK (log_index IS NULL OR log_index >= 0),
    status TEXT NOT NULL CHECK (status IN (
        'quoted', 'confirming', 'confirmed', 'failed', 'refunded'
    )),
    failure_reason TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    confirmed_block_number BIGINT CHECK (confirmed_block_number IS NULL OR confirmed_block_number >= 0),
    confirmed_block_hash TEXT CHECK (
        confirmed_block_hash IS NULL OR confirmed_block_hash ~ '^0x[0-9a-fA-F]{64}$'
    ),
    confirmed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    refunded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (funder_user_id, idempotency_key),
    CONSTRAINT reward_ticket_pool_funding_effects_received_shape_check
        CHECK (received_amount_atomic IS NULL OR status IN ('confirmed', 'refunded')),
    CONSTRAINT reward_ticket_pool_funding_effects_confirmed_shape_check
        CHECK (confirmed_at IS NULL OR status IN ('confirmed', 'refunded')),
    CONSTRAINT reward_ticket_pool_funding_effects_refunded_shape_check
        CHECK (refunded_at IS NULL OR status = 'refunded')
);

CREATE UNIQUE INDEX reward_ticket_pool_funding_effects_tx_unique
    ON reward_ticket_pool_funding_effects (chain_id, tx_hash, log_index)
    WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL;

CREATE INDEX reward_ticket_pool_funding_effects_fifo_idx
    ON reward_ticket_pool_funding_effects (
        reward_ticket_pool_id, confirmed_at, reward_ticket_pool_funding_effect_id
    )
    WHERE status IN ('confirmed', 'refunded');

CREATE TABLE reward_ticket_price_quotes (
    reward_ticket_price_quote_id TEXT PRIMARY KEY,
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    jackpot_address TEXT NOT NULL CHECK (jackpot_address ~ '^0x[0-9a-fA-F]{40}$'),
    drawing_id NUMERIC(78, 0) NOT NULL CHECK (drawing_id >= 0),
    payment_token_address TEXT NOT NULL
        CHECK (payment_token_address ~ '^0x[0-9a-fA-F]{40}$'),
    ticket_price_atomic NUMERIC(78, 0) NOT NULL CHECK (ticket_price_atomic > 0),
    ticket_price_cents BIGINT NOT NULL CHECK (ticket_price_cents > 0),
    observed_block_number BIGINT NOT NULL CHECK (observed_block_number >= 0),
    observed_block_hash TEXT NOT NULL CHECK (observed_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    observed_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain_id, jackpot_address, drawing_id, observed_block_hash),
    CONSTRAINT reward_ticket_price_quotes_freshness_check CHECK (expires_at > observed_at)
);

CREATE INDEX reward_ticket_price_quotes_freshness_idx
    ON reward_ticket_price_quotes (
        chain_id, jackpot_address, drawing_id, expires_at DESC, observed_at DESC
    );

CREATE TABLE reward_ticket_beneficiary_commitment_batches (
    reward_ticket_beneficiary_commitment_batch_id TEXT PRIMARY KEY,
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    jackpot_address TEXT NOT NULL CHECK (jackpot_address ~ '^0x[0-9a-fA-F]{40}$'),
    drawing_id NUMERIC(78, 0) NOT NULL CHECK (drawing_id >= 0),
    root_hash TEXT NOT NULL CHECK (root_hash ~ '^[0-9a-f]{64}$'),
    publication_kind TEXT NOT NULL,
    publication_reference TEXT,
    publication_tx_hash TEXT CHECK (
        publication_tx_hash IS NULL OR publication_tx_hash ~ '^0x[0-9a-fA-F]{64}$'
    ),
    publication_block_number BIGINT CHECK (
        publication_block_number IS NULL OR publication_block_number >= 0
    ),
    status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'failed', 'needs_review')),
    frozen_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain_id, jackpot_address, drawing_id, root_hash),
    CONSTRAINT reward_ticket_commitment_batches_published_shape_check
        CHECK (published_at IS NULL OR status = 'published')
);

CREATE TABLE reward_ticket_pool_drawings (
    reward_ticket_pool_drawing_id TEXT PRIMARY KEY,
    reward_ticket_pool_id TEXT NOT NULL
        REFERENCES reward_ticket_pools(reward_ticket_pool_id),
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    jackpot_address TEXT NOT NULL CHECK (jackpot_address ~ '^0x[0-9a-fA-F]{40}$'),
    drawing_id NUMERIC(78, 0) NOT NULL CHECK (drawing_id >= 0),
    status TEXT NOT NULL CHECK (status IN (
        'entry_open', 'closed_no_entries', 'cutoff_frozen', 'commit_pending',
        'purchase_pending', 'tickets_confirmed', 'drawing_pending', 'no_win',
        'winnings_detected', 'claim_pending', 'credited', 'operational_hold'
    )),
    entry_opens_at TIMESTAMPTZ NOT NULL,
    entry_cutoff_at TIMESTAMPTZ NOT NULL,
    drawing_resolves_at TIMESTAMPTZ NOT NULL,
    beneficiary_count INTEGER NOT NULL DEFAULT 0 CHECK (beneficiary_count >= 0),
    snapshot_hash TEXT CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'),
    commitment_batch_id TEXT REFERENCES reward_ticket_beneficiary_commitment_batches(
        reward_ticket_beneficiary_commitment_batch_id
    ),
    commitment_leaf_index INTEGER CHECK (commitment_leaf_index IS NULL OR commitment_leaf_index >= 0),
    commitment_inclusion_proof_json JSONB,
    price_quote_id TEXT REFERENCES reward_ticket_price_quotes(reward_ticket_price_quote_id),
    ticket_count INTEGER NOT NULL CHECK (ticket_count > 0),
    reserved_cents BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
    actual_cost_cents BIGINT CHECK (actual_cost_cents IS NULL OR actual_cost_cents >= 0),
    actual_cost_atomic NUMERIC(78, 0) CHECK (actual_cost_atomic IS NULL OR actual_cost_atomic >= 0),
    frozen_at TIMESTAMPTZ,
    committed_at TIMESTAMPTZ,
    tickets_confirmed_at TIMESTAMPTZ,
    drawing_resolved_at TIMESTAMPTZ,
    credited_at TIMESTAMPTZ,
    operational_hold_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (reward_ticket_pool_id, chain_id, jackpot_address, drawing_id),
    CONSTRAINT reward_ticket_pool_drawings_entry_window_check
        CHECK (entry_cutoff_at > entry_opens_at),
    CONSTRAINT reward_ticket_pool_drawings_resolution_window_check
        CHECK (drawing_resolves_at > entry_cutoff_at),
    CONSTRAINT reward_ticket_pool_drawings_snapshot_shape_check CHECK (
        (commitment_batch_id IS NULL AND commitment_leaf_index IS NULL
            AND commitment_inclusion_proof_json IS NULL)
        OR (commitment_batch_id IS NOT NULL AND commitment_leaf_index IS NOT NULL
            AND commitment_inclusion_proof_json IS NOT NULL)
    ),
    CONSTRAINT reward_ticket_pool_drawings_frozen_snapshot_check CHECK (
        status NOT IN (
            'cutoff_frozen', 'commit_pending', 'purchase_pending', 'tickets_confirmed',
            'drawing_pending', 'no_win', 'winnings_detected', 'claim_pending', 'credited'
        ) OR (snapshot_hash IS NOT NULL AND frozen_at IS NOT NULL)
    ),
    CONSTRAINT reward_ticket_pool_drawings_published_commitment_check CHECK (
        status NOT IN (
            'purchase_pending', 'tickets_confirmed', 'drawing_pending', 'no_win',
            'winnings_detected', 'claim_pending', 'credited'
        ) OR (commitment_batch_id IS NOT NULL AND committed_at IS NOT NULL)
    ),
    CONSTRAINT reward_ticket_pool_drawings_zero_entry_check CHECK (
        status <> 'closed_no_entries'
        OR (beneficiary_count = 0 AND reserved_cents = 0 AND actual_cost_cents IS NULL
            AND actual_cost_atomic IS NULL)
    ),
    CONSTRAINT reward_ticket_pool_drawings_operational_hold_check CHECK (
        status <> 'operational_hold' OR operational_hold_reason IS NOT NULL
    )
);

CREATE INDEX reward_ticket_pool_drawings_work_idx
    ON reward_ticket_pool_drawings (status, entry_cutoff_at, drawing_resolves_at, reward_ticket_pool_drawing_id);

CREATE TABLE reward_ticket_pool_beneficiaries (
    reward_ticket_pool_drawing_id TEXT NOT NULL
        REFERENCES reward_ticket_pool_drawings(reward_ticket_pool_drawing_id),
    reward_identity_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(user_id),
    reward_qualification_event_id TEXT NOT NULL
        REFERENCES reward_qualification_events(reward_qualification_event_id),
    qualification_evidence_hash TEXT NOT NULL
        CHECK (qualification_evidence_hash ~ '^[0-9a-f]{64}$'),
    canonical_position INTEGER CHECK (canonical_position IS NULL OR canonical_position >= 0),
    qualified_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (reward_ticket_pool_drawing_id, reward_identity_id),
    UNIQUE (reward_ticket_pool_drawing_id, reward_qualification_event_id),
    UNIQUE (reward_ticket_pool_drawing_id, canonical_position)
);

CREATE INDEX reward_ticket_pool_beneficiaries_identity_idx
    ON reward_ticket_pool_beneficiaries (reward_identity_id, qualified_at DESC);

CREATE TABLE reward_ticket_purchase_effects (
    reward_ticket_purchase_effect_id TEXT PRIMARY KEY,
    reward_ticket_pool_drawing_id TEXT NOT NULL
        REFERENCES reward_ticket_pool_drawings(reward_ticket_pool_drawing_id),
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN (
        'reserved', 'submitted', 'confirmed', 'failed', 'reservation_expired', 'needs_review'
    )),
    expected_ticket_count INTEGER NOT NULL CHECK (expected_ticket_count > 0),
    reserved_cents BIGINT NOT NULL CHECK (reserved_cents > 0),
    actual_cost_cents BIGINT CHECK (actual_cost_cents IS NULL OR actual_cost_cents > 0),
    actual_cost_atomic NUMERIC(78, 0) CHECK (actual_cost_atomic IS NULL OR actual_cost_atomic > 0),
    recipient_address TEXT NOT NULL CHECK (recipient_address ~ '^0x[0-9a-fA-F]{40}$'),
    tx_hash TEXT CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    submitted_block_number BIGINT CHECK (submitted_block_number IS NULL OR submitted_block_number >= 0),
    confirmed_block_number BIGINT CHECK (confirmed_block_number IS NULL OR confirmed_block_number >= 0),
    confirmed_block_hash TEXT CHECK (
        confirmed_block_hash IS NULL OR confirmed_block_hash ~ '^0x[0-9a-fA-F]{64}$'
    ),
    failure_reason TEXT,
    lease_token TEXT,
    lease_expires_at TIMESTAMPTZ,
    review_deadline_at TIMESTAMPTZ,
    next_reconciliation_at TIMESTAMPTZ,
    reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (reconciliation_attempt_count >= 0),
    submitted_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    reservation_expired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT reward_ticket_purchase_effects_lease_shape_check
        CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
    CONSTRAINT reward_ticket_purchase_effects_submitted_shape_check
        CHECK (status <> 'submitted' OR (tx_hash IS NOT NULL AND submitted_at IS NOT NULL)),
    CONSTRAINT reward_ticket_purchase_effects_confirmed_shape_check CHECK (status <> 'confirmed' OR (
        tx_hash IS NOT NULL AND actual_cost_cents IS NOT NULL AND actual_cost_atomic IS NOT NULL
        AND confirmed_block_number IS NOT NULL AND confirmed_block_hash IS NOT NULL
        AND confirmed_at IS NOT NULL
    )),
    CONSTRAINT reward_ticket_purchase_effects_failed_shape_check
        CHECK (status <> 'failed' OR failed_at IS NOT NULL),
    CONSTRAINT reward_ticket_purchase_effects_expired_shape_check
        CHECK (status <> 'reservation_expired' OR reservation_expired_at IS NOT NULL),
    CONSTRAINT reward_ticket_purchase_effects_review_shape_check CHECK (status <> 'needs_review' OR (
        review_deadline_at IS NOT NULL AND next_reconciliation_at IS NOT NULL
    ))
);

CREATE UNIQUE INDEX reward_ticket_purchase_effects_tx_unique
    ON reward_ticket_purchase_effects (tx_hash)
    WHERE tx_hash IS NOT NULL;

CREATE INDEX reward_ticket_purchase_effects_work_idx
    ON reward_ticket_purchase_effects (
        status, next_reconciliation_at, lease_expires_at, reward_ticket_purchase_effect_id
    );

CREATE TABLE reward_ticket_inventory (
    reward_ticket_inventory_id TEXT PRIMARY KEY,
    reward_ticket_pool_drawing_id TEXT NOT NULL
        REFERENCES reward_ticket_pool_drawings(reward_ticket_pool_drawing_id),
    reward_ticket_purchase_effect_id TEXT NOT NULL
        REFERENCES reward_ticket_purchase_effects(reward_ticket_purchase_effect_id),
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    ticket_nft_address TEXT NOT NULL CHECK (ticket_nft_address ~ '^0x[0-9a-fA-F]{40}$'),
    ticket_id NUMERIC(78, 0) NOT NULL CHECK (ticket_id >= 0),
    owner_address TEXT NOT NULL CHECK (owner_address ~ '^0x[0-9a-fA-F]{40}$'),
    status TEXT NOT NULL CHECK (status IN (
        'held', 'no_win', 'winning', 'claim_pending', 'claimed', 'needs_review'
    )),
    payout_tier INTEGER CHECK (payout_tier IS NULL OR payout_tier >= 0),
    observed_block_number BIGINT CHECK (observed_block_number IS NULL OR observed_block_number >= 0),
    observed_block_hash TEXT CHECK (
        observed_block_hash IS NULL OR observed_block_hash ~ '^0x[0-9a-fA-F]{64}$'
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain_id, ticket_nft_address, ticket_id)
);

CREATE INDEX reward_ticket_inventory_sweep_idx
    ON reward_ticket_inventory (status, reward_ticket_pool_drawing_id, ticket_id);

CREATE TABLE reward_ticket_claim_effects (
    reward_ticket_claim_effect_id TEXT PRIMARY KEY,
    reward_ticket_pool_drawing_id TEXT NOT NULL
        REFERENCES reward_ticket_pool_drawings(reward_ticket_pool_drawing_id),
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN (
        'detected', 'submitted', 'confirmed', 'failed', 'needs_review'
    )),
    tx_hash TEXT CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    protocol_reported_winnings_atomic NUMERIC(78, 0)
        CHECK (protocol_reported_winnings_atomic IS NULL OR protocol_reported_winnings_atomic > 0),
    received_amount_atomic NUMERIC(78, 0)
        CHECK (received_amount_atomic IS NULL OR received_amount_atomic > 0),
    confirmed_block_number BIGINT CHECK (confirmed_block_number IS NULL OR confirmed_block_number >= 0),
    confirmed_block_hash TEXT CHECK (
        confirmed_block_hash IS NULL OR confirmed_block_hash ~ '^0x[0-9a-fA-F]{64}$'
    ),
    failure_reason TEXT,
    lease_token TEXT,
    lease_expires_at TIMESTAMPTZ,
    review_deadline_at TIMESTAMPTZ,
    next_reconciliation_at TIMESTAMPTZ,
    reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (reconciliation_attempt_count >= 0),
    submitted_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT reward_ticket_claim_effects_lease_shape_check
        CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
    CONSTRAINT reward_ticket_claim_effects_submitted_shape_check
        CHECK (status <> 'submitted' OR (tx_hash IS NOT NULL AND submitted_at IS NOT NULL)),
    CONSTRAINT reward_ticket_claim_effects_confirmed_shape_check CHECK (status <> 'confirmed' OR (
        tx_hash IS NOT NULL AND protocol_reported_winnings_atomic IS NOT NULL
        AND received_amount_atomic IS NOT NULL
        AND confirmed_block_number IS NOT NULL AND confirmed_block_hash IS NOT NULL
        AND confirmed_at IS NOT NULL
    )),
    CONSTRAINT reward_ticket_claim_effects_failed_shape_check
        CHECK (status <> 'failed' OR failed_at IS NOT NULL),
    CONSTRAINT reward_ticket_claim_effects_review_shape_check CHECK (status <> 'needs_review' OR (
        review_deadline_at IS NOT NULL AND next_reconciliation_at IS NOT NULL
    ))
);

CREATE UNIQUE INDEX reward_ticket_claim_effects_tx_unique
    ON reward_ticket_claim_effects (tx_hash)
    WHERE tx_hash IS NOT NULL;

CREATE INDEX reward_ticket_claim_effects_work_idx
    ON reward_ticket_claim_effects (
        status, next_reconciliation_at, lease_expires_at, reward_ticket_claim_effect_id
    );

CREATE TABLE reward_ticket_claim_tickets (
    reward_ticket_claim_effect_id TEXT NOT NULL
        REFERENCES reward_ticket_claim_effects(reward_ticket_claim_effect_id),
    reward_ticket_inventory_id TEXT NOT NULL
        REFERENCES reward_ticket_inventory(reward_ticket_inventory_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (reward_ticket_claim_effect_id, reward_ticket_inventory_id),
    UNIQUE (reward_ticket_inventory_id)
);

CREATE TABLE reward_ticket_allocation_batches (
    reward_ticket_allocation_batch_id TEXT PRIMARY KEY,
    reward_ticket_pool_drawing_id TEXT NOT NULL
        REFERENCES reward_ticket_pool_drawings(reward_ticket_pool_drawing_id),
    idempotency_key TEXT NOT NULL UNIQUE,
    algorithm_version TEXT NOT NULL CHECK (algorithm_version = 'equal_v1'),
    beneficiary_count INTEGER NOT NULL CHECK (beneficiary_count > 0),
    proceeds_atomic NUMERIC(78, 0) NOT NULL CHECK (proceeds_atomic > 0),
    allocated_atomic NUMERIC(78, 0) NOT NULL CHECK (allocated_atomic >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'credited', 'needs_review')),
    credited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (reward_ticket_pool_drawing_id),
    CONSTRAINT reward_ticket_allocation_batches_amount_check
        CHECK (allocated_atomic <= proceeds_atomic),
    CONSTRAINT reward_ticket_allocation_batches_credited_shape_check CHECK (status <> 'credited' OR (
        allocated_atomic = proceeds_atomic AND credited_at IS NOT NULL
    ))
);

CREATE TABLE reward_ticket_allocation_batch_claims (
    reward_ticket_allocation_batch_id TEXT NOT NULL
        REFERENCES reward_ticket_allocation_batches(reward_ticket_allocation_batch_id),
    reward_ticket_claim_effect_id TEXT NOT NULL
        REFERENCES reward_ticket_claim_effects(reward_ticket_claim_effect_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (reward_ticket_allocation_batch_id, reward_ticket_claim_effect_id),
    UNIQUE (reward_ticket_claim_effect_id)
);

CREATE TABLE reward_ticket_allocations (
    reward_ticket_allocation_id TEXT PRIMARY KEY,
    reward_ticket_allocation_batch_id TEXT NOT NULL
        REFERENCES reward_ticket_allocation_batches(reward_ticket_allocation_batch_id),
    reward_ticket_pool_drawing_id TEXT NOT NULL,
    reward_identity_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(user_id),
    canonical_position INTEGER NOT NULL CHECK (canonical_position >= 0),
    amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
    amount_cents BIGINT CHECK (amount_cents IS NULL OR amount_cents > 0),
    received_remainder_unit BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (reward_ticket_pool_drawing_id, reward_identity_id)
        REFERENCES reward_ticket_pool_beneficiaries(
            reward_ticket_pool_drawing_id, reward_identity_id
        ),
    UNIQUE (reward_ticket_allocation_batch_id, reward_identity_id),
    UNIQUE (reward_ticket_allocation_batch_id, canonical_position)
);

CREATE TABLE reward_ticket_usdc_balances (
    user_id TEXT NOT NULL REFERENCES users(user_id),
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-fA-F]{40}$'),
    credited_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (credited_atomic >= 0),
    cashout_reserved_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0
        CHECK (cashout_reserved_atomic >= 0),
    paid_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (paid_atomic >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, chain_id, token_address),
    CONSTRAINT reward_ticket_usdc_balances_conservation_check
        CHECK (cashout_reserved_atomic + paid_atomic <= credited_atomic)
);

CREATE TABLE reward_ticket_usdc_ledger_entries (
    reward_ticket_usdc_ledger_entry_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    token_address TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    entry_kind TEXT NOT NULL CHECK (entry_kind IN (
        'pool_allocation_credit', 'cashout_reservation', 'cashout_release', 'cashout_payment'
    )),
    amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
    reward_ticket_allocation_id TEXT REFERENCES reward_ticket_allocations(reward_ticket_allocation_id),
    external_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (user_id, chain_id, token_address)
        REFERENCES reward_ticket_usdc_balances(user_id, chain_id, token_address),
    CONSTRAINT reward_ticket_usdc_ledger_entries_source_shape_check CHECK (
        (entry_kind = 'pool_allocation_credit' AND reward_ticket_allocation_id IS NOT NULL)
        OR (entry_kind <> 'pool_allocation_credit')
    )
);

CREATE UNIQUE INDEX reward_ticket_usdc_ledger_allocation_unique
    ON reward_ticket_usdc_ledger_entries (reward_ticket_allocation_id)
    WHERE reward_ticket_allocation_id IS NOT NULL;

CREATE TABLE reward_ticket_custody_solvency_observations (
    reward_ticket_custody_solvency_observation_id TEXT PRIMARY KEY,
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-fA-F]{40}$'),
    custody_address TEXT NOT NULL CHECK (custody_address ~ '^0x[0-9a-fA-F]{40}$'),
    custody_balance_atomic NUMERIC(78, 0) NOT NULL CHECK (custody_balance_atomic >= 0),
    outstanding_liability_atomic NUMERIC(78, 0) NOT NULL
        CHECK (outstanding_liability_atomic >= 0),
    canonical_block_number BIGINT NOT NULL CHECK (canonical_block_number >= 0),
    canonical_block_hash TEXT NOT NULL CHECK (canonical_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    status TEXT NOT NULL CHECK (status IN ('solvent', 'insolvent', 'stale', 'needs_review')),
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT reward_ticket_custody_solvency_status_check
        CHECK (status <> 'solvent' OR custody_balance_atomic >= outstanding_liability_atomic)
);

CREATE INDEX reward_ticket_custody_solvency_latest_idx
    ON reward_ticket_custody_solvency_observations (
        chain_id, token_address, custody_address, observed_at DESC
    );

CREATE TABLE reward_ticket_pool_monitor_state (
    monitor_key TEXT PRIMARY KEY CHECK (monitor_key IN (
        'price_quote_freshness', 'purchase_reconciliation', 'drawing_sweep_freshness',
        'claim_reconciliation', 'custody_solvency'
    )),
    status TEXT NOT NULL CHECK (status IN ('healthy', 'warning', 'critical')),
    owner_identifier TEXT NOT NULL,
    alert_destination TEXT NOT NULL,
    last_success_at TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ,
    next_check_at TIMESTAMPTZ,
    detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE reward_ticket_pool_incidents (
    reward_ticket_pool_incident_id TEXT PRIMARY KEY,
    reward_ticket_pool_id TEXT REFERENCES reward_ticket_pools(reward_ticket_pool_id),
    reward_ticket_pool_drawing_id TEXT
        REFERENCES reward_ticket_pool_drawings(reward_ticket_pool_drawing_id),
    incident_kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    owner_identifier TEXT NOT NULL,
    evidence_json JSONB NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolution_json JSONB,
    CONSTRAINT reward_ticket_pool_incidents_resolved_shape_check
        CHECK (status <> 'resolved' OR (resolved_at IS NOT NULL AND resolution_json IS NOT NULL))
);

CREATE UNIQUE INDEX reward_ticket_pool_incidents_one_open_kind
    ON reward_ticket_pool_incidents (
        COALESCE(reward_ticket_pool_id, ''),
        COALESCE(reward_ticket_pool_drawing_id, ''),
        incident_kind
    )
    WHERE status = 'open';

CREATE INDEX reward_ticket_pool_incidents_open_idx
    ON reward_ticket_pool_incidents (opened_at, reward_ticket_pool_incident_id)
    WHERE status = 'open';

REVOKE ALL ON TABLE
    reward_ticket_pools,
    reward_ticket_pool_funding_effects,
    reward_ticket_price_quotes,
    reward_ticket_beneficiary_commitment_batches,
    reward_ticket_pool_drawings,
    reward_ticket_pool_beneficiaries,
    reward_ticket_purchase_effects,
    reward_ticket_inventory,
    reward_ticket_claim_effects,
    reward_ticket_claim_tickets,
    reward_ticket_allocation_batches,
    reward_ticket_allocation_batch_claims,
    reward_ticket_allocations,
    reward_ticket_usdc_balances,
    reward_ticket_usdc_ledger_entries,
    reward_ticket_custody_solvency_observations,
    reward_ticket_pool_monitor_state,
    reward_ticket_pool_incidents
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    reward_ticket_pools,
    reward_ticket_pool_funding_effects,
    reward_ticket_price_quotes,
    reward_ticket_beneficiary_commitment_batches,
    reward_ticket_pool_drawings,
    reward_ticket_pool_beneficiaries,
    reward_ticket_purchase_effects,
    reward_ticket_inventory,
    reward_ticket_claim_effects,
    reward_ticket_claim_tickets,
    reward_ticket_allocation_batches,
    reward_ticket_allocation_batch_claims,
    reward_ticket_allocations,
    reward_ticket_usdc_balances,
    reward_ticket_usdc_ledger_entries,
    reward_ticket_custody_solvency_observations,
    reward_ticket_pool_monitor_state,
    reward_ticket_pool_incidents
TO control_plane_api_rw;

GRANT SELECT ON TABLE
    reward_ticket_pools,
    reward_ticket_pool_funding_effects,
    reward_ticket_price_quotes,
    reward_ticket_beneficiary_commitment_batches,
    reward_ticket_pool_drawings,
    reward_ticket_pool_beneficiaries,
    reward_ticket_purchase_effects,
    reward_ticket_inventory,
    reward_ticket_claim_effects,
    reward_ticket_claim_tickets,
    reward_ticket_allocation_batches,
    reward_ticket_allocation_batch_claims,
    reward_ticket_allocations,
    reward_ticket_usdc_balances,
    reward_ticket_usdc_ledger_entries,
    reward_ticket_custody_solvency_observations,
    reward_ticket_pool_monitor_state,
    reward_ticket_pool_incidents
TO control_plane_api_ro, control_plane_ops_ro;
