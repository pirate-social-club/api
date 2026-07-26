-- Persist the last successful on-chain treasury observation used by the
-- rewards admission gate. The gate derives staleness from observed_at rather
-- than treating a transient RPC failure as a fresh result.
CREATE TABLE reward_solvency_observations (
    observation_key TEXT PRIMARY KEY CHECK (observation_key = 'rewards_treasury'),
    chain_id BIGINT NOT NULL CHECK (chain_id > 0),
    treasury_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    balance_atomic TEXT NOT NULL,
    contribution_liability_cents BIGINT NOT NULL
        CHECK (contribution_liability_cents >= 0),
    credited_unpaid_liability_cents BIGINT NOT NULL
        CHECK (credited_unpaid_liability_cents >= 0),
    pending_refund_atomic TEXT NOT NULL,
    total_liability_atomic TEXT NOT NULL,
    solvent BOOLEAN NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX reward_solvency_observations_freshness_idx
    ON reward_solvency_observations (observed_at DESC);
