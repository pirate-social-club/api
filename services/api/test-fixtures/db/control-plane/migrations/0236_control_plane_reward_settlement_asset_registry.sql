-- Reward settlement-asset registry and rail bindings.
--
-- First slice of the ERC-20 multi-asset reward settlement program
-- (specs/domain/erc20-multi-asset-reward-settlement.md). Two concepts,
-- two tables: an asset row is the intrinsic token identity and admission
-- state (chain, address, decimals, symbol, denomination policy,
-- lifecycle); a rail row binds an admitted asset to an
-- environment-specific execution configuration (backend, treasury,
-- vault, operator, policy version). USDC on Base is one asset, but
-- staging and production custody it through different rails.
--
-- This migration creates the control plane only. It does not change how
-- money moves: the API keeps resolving its settlement asset from
-- deployment configuration until the registry reader lands, and the
-- api-rw role receives SELECT only, so no asset can be admitted,
-- suspended, or rebound through the API. Phase-one admission policy is
-- deliberately frozen in schema: denomination_policy accepts only
-- 'usd_par' (1 token = 1 USD, exact cents scaling) and decimals must be
-- at least 2, so a priced or sub-cent asset requires a deliberate later
-- migration, not a data change.
--
-- Scope: these tables hold CURRENT STATE, not an audit log. Lifecycle
-- timestamps may change only together with a status transition (see the
-- trigger below), and re-admission after a suspension clears
-- suspended_at because an admitted row must read as admitted. Who acted
-- and why, beyond the original admission authorization, is not recorded
-- here. In this slice that is acceptable because migrations — which are
-- version-controlled and ledger-verified — are the only mutation path.
-- Before any runtime mutation is granted (the operator
-- admission/suspension/retirement slice), an append-only lifecycle
-- event ledger with actor and authorization evidence MUST land; that
-- grant change and the event ledger belong to the same migration.
--
-- Token addresses are stored lowercase, matching reward_campaigns
-- (0231), observed_funding_receipts (0143), and
-- reward_funding_asset_retirements (0195). Custody addresses
-- (treasury/vault/operator) are checksum-agnostic like the signer and
-- target addresses in 0235.

CREATE TABLE reward_settlement_assets (
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
    decimals INTEGER NOT NULL CHECK (decimals >= 2 AND decimals <= 36),
    symbol TEXT NOT NULL CHECK (length(symbol) >= 1 AND length(symbol) <= 20),
    denomination_policy TEXT NOT NULL CHECK (denomination_policy = 'usd_par'),
    status TEXT NOT NULL CHECK (status IN ('admitted', 'suspended', 'retired')),
    admitted_at TIMESTAMPTZ NOT NULL,
    admitted_by TEXT NOT NULL CHECK (length(admitted_by) >= 1 AND length(admitted_by) <= 200),
    authorization_reference TEXT NOT NULL CHECK (
        length(authorization_reference) >= 1 AND length(authorization_reference) <= 500
    ),
    suspended_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    quote_cutoff_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chain_id, token_address),
    CONSTRAINT reward_settlement_assets_admitted_shape_check CHECK (
        status <> 'admitted'
        OR (suspended_at IS NULL AND retired_at IS NULL AND quote_cutoff_at IS NULL)
    ),
    CONSTRAINT reward_settlement_assets_suspended_shape_check CHECK (
        status <> 'suspended'
        OR (suspended_at IS NOT NULL AND retired_at IS NULL AND quote_cutoff_at IS NULL)
    ),
    CONSTRAINT reward_settlement_assets_retired_shape_check CHECK (
        status <> 'retired' OR (retired_at IS NOT NULL AND quote_cutoff_at IS NOT NULL)
    )
);

CREATE TABLE reward_settlement_rails (
    reward_settlement_rail_id TEXT PRIMARY KEY,
    environment TEXT NOT NULL CHECK (environment IN ('local', 'staging', 'production')),
    backend TEXT NOT NULL CHECK (backend IN ('local', 'eoa_vault', 'lit_vault')),
    chain_id INTEGER NOT NULL,
    token_address TEXT NOT NULL,
    treasury_address TEXT NOT NULL CHECK (treasury_address ~ '^0x[0-9a-fA-F]{40}$'),
    vault_address TEXT CHECK (vault_address IS NULL OR vault_address ~ '^0x[0-9a-fA-F]{40}$'),
    operator_address TEXT NOT NULL CHECK (operator_address ~ '^0x[0-9a-fA-F]{40}$'),
    policy_version TEXT NOT NULL CHECK (length(policy_version) >= 1 AND length(policy_version) <= 100),
    status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (chain_id, token_address)
        REFERENCES reward_settlement_assets (chain_id, token_address),
    CONSTRAINT reward_settlement_rails_vault_shape_check CHECK (
        (backend IN ('eoa_vault', 'lit_vault') AND vault_address IS NOT NULL)
        OR (backend = 'local' AND vault_address IS NULL)
    )
);

-- One live rail per (environment, asset); rebinding retires the old row
-- and inserts a new one so custody history stays auditable.
CREATE UNIQUE INDEX reward_settlement_rails_active_binding_idx
    ON reward_settlement_rails (environment, chain_id, token_address)
    WHERE status = 'active';

CREATE OR REPLACE FUNCTION enforce_reward_settlement_asset_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'retired' THEN
        RAISE EXCEPTION 'retired reward settlement asset is frozen';
    END IF;

    IF NEW.chain_id IS DISTINCT FROM OLD.chain_id
        OR NEW.token_address IS DISTINCT FROM OLD.token_address
        OR NEW.decimals IS DISTINCT FROM OLD.decimals
        OR NEW.symbol IS DISTINCT FROM OLD.symbol
        OR NEW.denomination_policy IS DISTINCT FROM OLD.denomination_policy
        OR NEW.admitted_at IS DISTINCT FROM OLD.admitted_at
        OR NEW.admitted_by IS DISTINCT FROM OLD.admitted_by
        OR NEW.authorization_reference IS DISTINCT FROM OLD.authorization_reference
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'reward settlement asset identity is immutable';
    END IF;

    -- Lifecycle timestamps are transition evidence, not free-form fields: a
    -- same-status update may not touch them, and retirement must carry the
    -- suspension history it inherited forward unchanged. The status CHECKs
    -- above pin which timestamps each transition must set or clear.
    IF NEW.status = OLD.status THEN
        IF NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
            OR NEW.retired_at IS DISTINCT FROM OLD.retired_at
            OR NEW.quote_cutoff_at IS DISTINCT FROM OLD.quote_cutoff_at THEN
            RAISE EXCEPTION 'reward settlement asset lifecycle evidence changes only with a status transition';
        END IF;
    ELSIF OLD.status = 'admitted' AND NEW.status = 'suspended' THEN
        NULL;
    ELSIF OLD.status = 'suspended' AND NEW.status = 'admitted' THEN
        NULL;
    ELSIF NEW.status = 'retired' THEN
        IF NEW.suspended_at IS DISTINCT FROM OLD.suspended_at THEN
            RAISE EXCEPTION 'suspension evidence is preserved through retirement';
        END IF;
    ELSE
        RAISE EXCEPTION 'invalid reward settlement asset lifecycle transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reward_settlement_assets_lifecycle
BEFORE UPDATE ON reward_settlement_assets
FOR EACH ROW EXECUTE FUNCTION enforce_reward_settlement_asset_lifecycle();

CREATE OR REPLACE FUNCTION reject_reward_settlement_registry_deletion()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'reward settlement registry rows are append-only; retire instead of deleting';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reward_settlement_assets_no_delete
BEFORE DELETE ON reward_settlement_assets
FOR EACH ROW EXECUTE FUNCTION reject_reward_settlement_registry_deletion();

CREATE TRIGGER reward_settlement_rails_no_delete
BEFORE DELETE ON reward_settlement_rails
FOR EACH ROW EXECUTE FUNCTION reject_reward_settlement_registry_deletion();

-- A rail row is a custody-binding snapshot: everything except its
-- active->retired transition is immutable. Rebinding is a new row.
CREATE OR REPLACE FUNCTION enforce_reward_settlement_rail_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.reward_settlement_rail_id IS DISTINCT FROM OLD.reward_settlement_rail_id
        OR NEW.environment IS DISTINCT FROM OLD.environment
        OR NEW.backend IS DISTINCT FROM OLD.backend
        OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
        OR NEW.token_address IS DISTINCT FROM OLD.token_address
        OR NEW.treasury_address IS DISTINCT FROM OLD.treasury_address
        OR NEW.vault_address IS DISTINCT FROM OLD.vault_address
        OR NEW.operator_address IS DISTINCT FROM OLD.operator_address
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'reward settlement rail binding is immutable';
    END IF;

    IF NOT (
        NEW.status = OLD.status
        OR (OLD.status = 'active' AND NEW.status = 'retired')
    ) THEN
        RAISE EXCEPTION 'invalid reward settlement rail state transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reward_settlement_rails_transition
BEFORE UPDATE ON reward_settlement_rails
FOR EACH ROW EXECUTE FUNCTION enforce_reward_settlement_rail_transition();

-- Seed the canonical USDC identities the deployment configuration
-- already settles in today. Addresses match CANONICAL_USDC_BY_CHAIN in
-- the API (booking-settlement-config.ts / booking-chain-config.ts),
-- lowercased. No rail rows are seeded: treasury, vault, and operator
-- bindings are environment-specific deployment facts and land through
-- the registry integration slice, not a shared migration.
INSERT INTO reward_settlement_assets (
    chain_id, token_address, decimals, symbol, denomination_policy,
    status, admitted_at, admitted_by, authorization_reference
) VALUES
    (
        8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 6, 'USDC', 'usd_par',
        'admitted', NOW(), 'migration:0236',
        'specs/domain/erc20-multi-asset-reward-settlement.md (core #563); pre-registry canonical asset'
    ),
    (
        84532, '0x036cbd53842c5426634e7929541ec2318f3dcf7e', 6, 'USDC', 'usd_par',
        'admitted', NOW(), 'migration:0236',
        'specs/domain/erc20-multi-asset-reward-settlement.md (core #563); pre-registry canonical asset'
    );

-- The API may read the registry but cannot admit, suspend, retire, or
-- rebind anything: registry mutations stay with migrations and the
-- later operator workflow slice. This keeps non-USDC activation
-- impossible from the runtime path by construction.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_plane_api_rw') THEN
        GRANT SELECT ON TABLE
            reward_settlement_assets,
            reward_settlement_rails
        TO control_plane_api_rw;
        REVOKE INSERT, UPDATE, DELETE ON TABLE
            reward_settlement_assets,
            reward_settlement_rails
        FROM control_plane_api_rw;
    END IF;
END
$$;
