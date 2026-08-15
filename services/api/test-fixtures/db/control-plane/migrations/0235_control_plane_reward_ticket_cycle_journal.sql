-- Durable scheduler and exact-transaction journal for unattended Megapot cycles.
--
-- A signed transaction must be committed here before it is broadcast. This
-- permits crash recovery to rebroadcast the exact bytes without consuming a
-- second nonce or creating a second economic effect.

CREATE TABLE reward_ticket_automation_cycles (
    reward_ticket_automation_cycle_id TEXT PRIMARY KEY,
    schedule_key TEXT NOT NULL UNIQUE,
    chain_id INTEGER NOT NULL CHECK (chain_id = 84532),
    jackpot_address TEXT NOT NULL CHECK (jackpot_address ~ '^0x[0-9a-fA-F]{40}$'),
    drawing_id NUMERIC(78, 0) NOT NULL CHECK (drawing_id >= 0),
    status TEXT NOT NULL CHECK (status IN (
        'planned', 'freezing', 'publishing', 'purchasing', 'drawing_pending',
        'sweeping', 'claiming', 'crediting', 'completed', 'paused',
        'recovery_required', 'failed'
    )),
    runner_version TEXT NOT NULL,
    source_commit TEXT NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
    scheduled_for TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain_id, jackpot_address, drawing_id),
    CONSTRAINT reward_ticket_automation_cycles_lease_shape_check CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CONSTRAINT reward_ticket_automation_cycles_completed_shape_check CHECK (
        (status = 'completed' AND completed_at IS NOT NULL AND failure_reason IS NULL)
        OR (status <> 'completed' AND completed_at IS NULL)
    ),
    CONSTRAINT reward_ticket_automation_cycles_failure_shape_check CHECK (
        status NOT IN ('recovery_required', 'failed') OR failure_reason IS NOT NULL
    )
);

CREATE INDEX reward_ticket_automation_cycles_work_idx
    ON reward_ticket_automation_cycles (
        status, scheduled_for, lease_expires_at, reward_ticket_automation_cycle_id
    )
    WHERE status NOT IN ('completed', 'failed');

CREATE TABLE reward_ticket_evm_submissions (
    reward_ticket_evm_submission_id TEXT PRIMARY KEY,
    reward_ticket_automation_cycle_id TEXT NOT NULL
        REFERENCES reward_ticket_automation_cycles(reward_ticket_automation_cycle_id),
    operation_id TEXT NOT NULL UNIQUE,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN (
        'commitment_publication', 'ticket_purchase', 'winnings_claim',
        'pause_control', 'recovery_control', 'pool_funding'
    )),
    chain_id INTEGER NOT NULL CHECK (chain_id = 84532),
    signer_address TEXT NOT NULL CHECK (signer_address ~ '^0x[0-9a-fA-F]{40}$'),
    nonce NUMERIC(78, 0) NOT NULL CHECK (nonce >= 0),
    target_address TEXT NOT NULL CHECK (target_address ~ '^0x[0-9a-fA-F]{40}$'),
    call_data_hash TEXT NOT NULL CHECK (call_data_hash ~ '^0x[0-9a-fA-F]{64}$'),
    value_wei NUMERIC(78, 0) NOT NULL CHECK (value_wei >= 0),
    signed_transaction TEXT NOT NULL CHECK (signed_transaction ~ '^0x[0-9a-fA-F]+$'),
    transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
    status TEXT NOT NULL CHECK (status IN (
        'prepared', 'broadcast', 'confirmed', 'reverted', 'needs_review'
    )),
    broadcast_at TIMESTAMPTZ,
    confirmed_block_number BIGINT CHECK (
        confirmed_block_number IS NULL OR confirmed_block_number >= 0
    ),
    confirmed_block_hash TEXT CHECK (
        confirmed_block_hash IS NULL OR confirmed_block_hash ~ '^0x[0-9a-fA-F]{64}$'
    ),
    confirmed_at TIMESTAMPTZ,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain_id, signer_address, nonce),
    UNIQUE (chain_id, transaction_hash),
    CONSTRAINT reward_ticket_evm_submissions_broadcast_shape_check CHECK (
        status = 'prepared' OR broadcast_at IS NOT NULL
    ),
    CONSTRAINT reward_ticket_evm_submissions_finality_shape_check CHECK (
        (status IN ('confirmed', 'reverted')
            AND confirmed_block_number IS NOT NULL
            AND confirmed_block_hash IS NOT NULL
            AND confirmed_at IS NOT NULL)
        OR (status NOT IN ('confirmed', 'reverted')
            AND confirmed_block_number IS NULL
            AND confirmed_block_hash IS NULL
            AND confirmed_at IS NULL)
    ),
    CONSTRAINT reward_ticket_evm_submissions_failure_shape_check CHECK (
        status NOT IN ('reverted', 'needs_review') OR failure_reason IS NOT NULL
    )
);

CREATE INDEX reward_ticket_evm_submissions_recovery_idx
    ON reward_ticket_evm_submissions (
        status, updated_at, reward_ticket_evm_submission_id
    )
    WHERE status IN ('prepared', 'broadcast', 'needs_review');

CREATE TABLE reward_ticket_automation_evidence (
    reward_ticket_automation_evidence_id TEXT PRIMARY KEY,
    reward_ticket_automation_cycle_id TEXT NOT NULL
        REFERENCES reward_ticket_automation_cycles(reward_ticket_automation_cycle_id),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
        'cycle_started', 'beneficiaries_frozen', 'commitment_published',
        'tickets_purchased', 'drawing_observed', 'claim_observed',
        'allocation_credited', 'solvency_observed', 'pause_drill',
        'crash_restart_drill', 'recovery_drill', 'cycle_completed', 'alert'
    )),
    evidence_json JSONB NOT NULL CHECK (jsonb_typeof(evidence_json) = 'object'),
    evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (reward_ticket_automation_cycle_id, sequence_number),
    UNIQUE (reward_ticket_automation_cycle_id, evidence_hash)
);

CREATE INDEX reward_ticket_automation_evidence_timeline_idx
    ON reward_ticket_automation_evidence (
        reward_ticket_automation_cycle_id, sequence_number
    );

CREATE OR REPLACE FUNCTION enforce_reward_ticket_evm_submission_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.operation_kind IS DISTINCT FROM OLD.operation_kind
        OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
        OR NEW.signer_address IS DISTINCT FROM OLD.signer_address
        OR NEW.nonce IS DISTINCT FROM OLD.nonce
        OR NEW.target_address IS DISTINCT FROM OLD.target_address
        OR NEW.call_data_hash IS DISTINCT FROM OLD.call_data_hash
        OR NEW.value_wei IS DISTINCT FROM OLD.value_wei
        OR NEW.signed_transaction IS DISTINCT FROM OLD.signed_transaction
        OR NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash THEN
        RAISE EXCEPTION 'prepared reward ticket transaction identity is immutable';
    END IF;

    IF NOT (
        NEW.status = OLD.status
        OR (OLD.status = 'prepared' AND NEW.status IN ('broadcast', 'needs_review'))
        OR (OLD.status = 'broadcast' AND NEW.status IN ('confirmed', 'reverted', 'needs_review'))
        OR (OLD.status = 'needs_review' AND NEW.status IN ('broadcast', 'confirmed', 'reverted'))
    ) THEN
        RAISE EXCEPTION 'invalid reward ticket transaction state transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reward_ticket_evm_submissions_transition
BEFORE UPDATE ON reward_ticket_evm_submissions
FOR EACH ROW EXECUTE FUNCTION enforce_reward_ticket_evm_submission_transition();

CREATE OR REPLACE FUNCTION reject_reward_ticket_automation_evidence_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'reward ticket automation evidence is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reward_ticket_automation_evidence_immutable
BEFORE UPDATE OR DELETE ON reward_ticket_automation_evidence
FOR EACH ROW EXECUTE FUNCTION reject_reward_ticket_automation_evidence_mutation();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_plane_api_rw') THEN
        GRANT SELECT, INSERT, UPDATE ON TABLE
            reward_ticket_automation_cycles,
            reward_ticket_evm_submissions
        TO control_plane_api_rw;
        GRANT SELECT, INSERT ON TABLE reward_ticket_automation_evidence
        TO control_plane_api_rw;
        REVOKE DELETE ON TABLE
            reward_ticket_automation_cycles,
            reward_ticket_evm_submissions,
            reward_ticket_automation_evidence
        FROM control_plane_api_rw;
    END IF;
END
$$;
