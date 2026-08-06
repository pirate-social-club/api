-- Explicitly authorized settlement-asset retirements. A chain mismatch alone is
-- never evidence that an asset is valueless or safe to abandon. Each row owns
-- that decision for one exact chain/token/treasury tuple and cutoff.

CREATE TABLE reward_funding_asset_retirements (
    reward_funding_asset_retirement_id TEXT PRIMARY KEY,
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    token_address TEXT NOT NULL,
    treasury_address TEXT NOT NULL,
    quote_cutoff_at TIMESTAMPTZ NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN (
        'non_material_test_asset',
        'treasury_verified_no_unclaimed_value'
    )),
    authorized_by TEXT NOT NULL CHECK (length(trim(authorized_by)) > 0),
    authorization_reference TEXT NOT NULL
        CHECK (length(trim(authorization_reference)) > 0),
    authorized_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain_id, token_address, treasury_address),
    CONSTRAINT reward_funding_asset_retirements_token_lowercase_check
        CHECK (token_address = lower(token_address)),
    CONSTRAINT reward_funding_asset_retirements_treasury_lowercase_check
        CHECK (treasury_address = lower(treasury_address))
);

-- Immutable evidence for every funding effect whose campaign slot is released.
-- Snapshot the quote timing and custody coordinates so a late-surfacing transfer
-- can be reconstructed without relying on mutable campaign state.
CREATE TABLE reward_retired_funding_cancellations (
    reward_retired_funding_cancellation_id TEXT PRIMARY KEY,
    reward_funding_asset_retirement_id TEXT NOT NULL,
    reward_campaign_funding_effect_id TEXT NOT NULL UNIQUE,
    reward_campaign_id TEXT NOT NULL,
    funder_user_id TEXT NOT NULL,
    sender_address TEXT NOT NULL,
    expected_amount_cents INTEGER NOT NULL CHECK (expected_amount_cents > 0),
    expected_amount_atomic TEXT NOT NULL,
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    token_address TEXT NOT NULL,
    treasury_address TEXT NOT NULL,
    quote_created_at TIMESTAMPTZ NOT NULL,
    quote_expires_at TIMESTAMPTZ NOT NULL,
    canceled_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (reward_funding_asset_retirement_id)
        REFERENCES reward_funding_asset_retirements(reward_funding_asset_retirement_id),
    FOREIGN KEY (reward_campaign_funding_effect_id)
        REFERENCES reward_campaign_funding_effects(reward_campaign_funding_effect_id),
    FOREIGN KEY (reward_campaign_id)
        REFERENCES reward_campaigns(reward_campaign_id),
    FOREIGN KEY (funder_user_id) REFERENCES users(user_id)
);

CREATE INDEX reward_retired_funding_cancellations_campaign_idx
    ON reward_retired_funding_cancellations (reward_campaign_id, canceled_at);

-- Effects created after a retirement cutoff indicate stale configuration or
-- routing. Persist the anomaly and leave its campaign untouched for operators.
CREATE TABLE reward_funding_retirement_anomalies (
    reward_funding_retirement_anomaly_id TEXT PRIMARY KEY,
    reward_funding_asset_retirement_id TEXT NOT NULL,
    reward_campaign_funding_effect_id TEXT NOT NULL UNIQUE,
    reward_campaign_id TEXT NOT NULL,
    anomaly_kind TEXT NOT NULL CHECK (anomaly_kind = 'quote_created_after_cutoff'),
    effect_created_at TIMESTAMPTZ NOT NULL,
    quote_cutoff_at TIMESTAMPTZ NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (reward_funding_asset_retirement_id)
        REFERENCES reward_funding_asset_retirements(reward_funding_asset_retirement_id),
    FOREIGN KEY (reward_campaign_funding_effect_id)
        REFERENCES reward_campaign_funding_effects(reward_campaign_funding_effect_id),
    FOREIGN KEY (reward_campaign_id)
        REFERENCES reward_campaigns(reward_campaign_id)
);

CREATE INDEX reward_funding_retirement_anomalies_detected_idx
    ON reward_funding_retirement_anomalies (detected_at, reward_campaign_id);

-- Production moved rewards from this Base Sepolia faucet asset to Base mainnet
-- in release run 30581575428. The production deploy completed at the cutoff
-- below. Because the retired asset is explicitly classified as non-material,
-- cancellation removes no recoverable-value path; current-chain quotes are not
-- covered by this declaration.
INSERT INTO reward_funding_asset_retirements (
    reward_funding_asset_retirement_id,
    chain_id,
    token_address,
    treasury_address,
    quote_cutoff_at,
    disposition,
    authorized_by,
    authorization_reference,
    authorized_at
) VALUES (
    'rfr_base_sepolia_rewards_20260730',
    84532,
    '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    '0xc74e72ce521674bcaea66c99874fe9d5984e12be',
    '2026-07-30T21:17:40.000Z',
    'non_material_test_asset',
    'alex',
    'web-release-run:30581575428;retirement-review:2026-08-06',
    '2026-08-06T00:00:00.000Z'
);
