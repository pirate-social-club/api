// Admin-only bootstrap for reward settlement rail bindings (core migration
// 0236). The API role holds SELECT alone on the registry tables, so rail rows
// can only come from migrations or this operator-run bootstrap, executed with
// a privileged database credential through
// scripts/bootstrap-reward-settlement-rail.ts.
//
// Ratified properties: transactional (caller owns BEGIN/COMMIT/ROLLBACK and
// every read uses FOR UPDATE), idempotent (an identical active binding is a
// no-op), dry-run capable, refuses conflicting existing rows instead of
// mutating them, and reads back the exact inserted row as evidence. Rebinding
// is deliberately out of scope: retire the old rail first, then bootstrap.

export type SettlementRailBootstrapPlan = {
  environment: "local" | "staging" | "production"
  backend: "local" | "eoa_vault" | "lit_vault"
  chainId: number
  tokenAddress: string
  treasuryAddress: string
  vaultAddress: string | null
  operatorAddress: string
  policyVersion: string
  railId: string
}

export type SettlementRailBinding = {
  railId: string
  environment: string
  backend: string
  chainId: number
  tokenAddress: string
  treasuryAddress: string
  vaultAddress: string | null
  operatorAddress: string
  policyVersion: string
  status: string
  createdAt: string
}

export type SettlementRailBootstrapOutcome =
  | { outcome: "inserted"; binding: SettlementRailBinding }
  | { outcome: "already_bound"; binding: SettlementRailBinding }
  | { outcome: "dry_run_would_insert"; plan: SettlementRailBootstrapPlan }
  | { outcome: "dry_run_already_bound"; binding: SettlementRailBinding }

// Rows come back with driver-specific scalar types; the executor is any
// transactional handle that can run parameterised SQL (Bun.SQL.unsafe).
export type BootstrapSqlExecutor = {
  unsafe: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
}

export class SettlementRailBootstrapError extends Error {
  readonly reason: string
  readonly details: Record<string, unknown>

  constructor(reason: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.reason = reason
    this.details = details
  }
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function normalizedAddress(raw: unknown, field: string): string {
  const value = String(raw ?? "").trim()
  if (!EVM_ADDRESS_RE.test(value)) {
    throw new SettlementRailBootstrapError("invalid_input", `${field} must be a 0x-prefixed 40-hex EVM address`, { field })
  }
  return value.toLowerCase()
}

export function planSettlementRailBootstrap(input: {
  environment: string
  backend: string
  chainId: string | number
  tokenAddress: string
  treasuryAddress: string
  operatorAddress: string
  vaultAddress?: string | null
  policyVersion?: string
  randomHex: string
}): SettlementRailBootstrapPlan {
  const environment = String(input.environment ?? "").trim().toLowerCase()
  if (environment !== "local" && environment !== "staging" && environment !== "production") {
    throw new SettlementRailBootstrapError("invalid_input", "environment must be local, staging, or production", {
      field: "environment",
    })
  }
  const backend = String(input.backend ?? "").trim()
  if (backend !== "local" && backend !== "eoa_vault" && backend !== "lit_vault") {
    throw new SettlementRailBootstrapError("invalid_input", "backend must be local, eoa_vault, or lit_vault", {
      field: "backend",
    })
  }
  const chainId = Number(String(input.chainId ?? "").trim())
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new SettlementRailBootstrapError("invalid_input", "chain-id must be a positive integer", { field: "chain-id" })
  }
  const vaultRaw = String(input.vaultAddress ?? "").trim()
  if (backend === "local" && vaultRaw !== "") {
    throw new SettlementRailBootstrapError("invalid_input", "vault-address must be omitted for the local backend", {
      field: "vault-address",
    })
  }
  if (backend !== "local" && vaultRaw === "") {
    throw new SettlementRailBootstrapError("invalid_input", `vault-address is required for the ${backend} backend`, {
      field: "vault-address",
    })
  }
  const policyVersion = String(input.policyVersion ?? "v1").trim()
  if (policyVersion.length < 1 || policyVersion.length > 100) {
    throw new SettlementRailBootstrapError("invalid_input", "policy-version must be 1-100 characters", {
      field: "policy-version",
    })
  }
  if (!/^[0-9a-f]{8}$/.test(input.randomHex)) {
    throw new SettlementRailBootstrapError("invalid_input", "randomHex must be 8 lowercase hex characters", {
      field: "randomHex",
    })
  }
  const tokenAddress = normalizedAddress(input.tokenAddress, "token-address")
  return {
    environment,
    backend,
    chainId,
    tokenAddress,
    treasuryAddress: normalizedAddress(input.treasuryAddress, "treasury-address"),
    vaultAddress: backend === "local" ? null : normalizedAddress(vaultRaw, "vault-address"),
    operatorAddress: normalizedAddress(input.operatorAddress, "operator-address"),
    policyVersion,
    railId: `rail_${environment}_${chainId}_${tokenAddress.slice(2, 10)}_${input.randomHex}`,
  }
}

function bindingFromRow(row: Record<string, unknown>): SettlementRailBinding {
  return {
    railId: String(row.reward_settlement_rail_id),
    environment: String(row.environment),
    backend: String(row.backend),
    chainId: Number(row.chain_id),
    tokenAddress: String(row.token_address),
    treasuryAddress: String(row.treasury_address),
    vaultAddress: row.vault_address == null ? null : String(row.vault_address),
    operatorAddress: String(row.operator_address),
    policyVersion: String(row.policy_version),
    status: String(row.status),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

function bindingMatchesPlan(binding: SettlementRailBinding, plan: SettlementRailBootstrapPlan): boolean {
  return (
    binding.backend === plan.backend
    && binding.treasuryAddress.toLowerCase() === plan.treasuryAddress
    && (binding.vaultAddress == null ? null : binding.vaultAddress.toLowerCase()) === plan.vaultAddress
    && binding.operatorAddress.toLowerCase() === plan.operatorAddress
    && binding.policyVersion === plan.policyVersion
  )
}

// Must be called inside an open transaction owned by the caller; every read
// takes FOR UPDATE so a concurrent bootstrap serialises instead of racing the
// partial unique index.
export async function executeSettlementRailBootstrap(
  tx: BootstrapSqlExecutor,
  plan: SettlementRailBootstrapPlan,
  options: { dryRun: boolean },
): Promise<SettlementRailBootstrapOutcome> {
  const assets = await tx.unsafe(
    `SELECT status, denomination_policy FROM reward_settlement_assets
      WHERE chain_id = $1 AND token_address = $2 FOR UPDATE`,
    [plan.chainId, plan.tokenAddress],
  )
  const asset = assets[0]
  if (!asset) {
    throw new SettlementRailBootstrapError("asset_missing", "no settlement asset is registered for this chain and token", {
      chain_id: plan.chainId,
      token_address: plan.tokenAddress,
    })
  }
  if (String(asset.status) !== "admitted") {
    throw new SettlementRailBootstrapError(
      "asset_not_admitted",
      `settlement asset is ${String(asset.status)}; only admitted assets may be bound to a rail`,
      { status: String(asset.status) },
    )
  }

  const existing = await tx.unsafe(
    `SELECT reward_settlement_rail_id, environment, backend, chain_id, token_address,
        treasury_address, vault_address, operator_address, policy_version, status, created_at
      FROM reward_settlement_rails
      WHERE environment = $1 AND chain_id = $2 AND token_address = $3 AND status = 'active'
      FOR UPDATE`,
    [plan.environment, plan.chainId, plan.tokenAddress],
  )
  if (existing[0]) {
    const binding = bindingFromRow(existing[0])
    if (bindingMatchesPlan(binding, plan)) {
      return options.dryRun ? { outcome: "dry_run_already_bound", binding } : { outcome: "already_bound", binding }
    }
    throw new SettlementRailBootstrapError(
      "conflicting_active_rail",
      "an active rail with a different binding already exists; retire it deliberately before rebinding",
      { existing_rail_id: binding.railId },
    )
  }

  if (options.dryRun) {
    return { outcome: "dry_run_would_insert", plan }
  }

  await tx.unsafe(
    `INSERT INTO reward_settlement_rails (
        reward_settlement_rail_id, environment, backend, chain_id, token_address,
        treasury_address, vault_address, operator_address, policy_version, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')`,
    [
      plan.railId,
      plan.environment,
      plan.backend,
      plan.chainId,
      plan.tokenAddress,
      plan.treasuryAddress,
      plan.vaultAddress,
      plan.operatorAddress,
      plan.policyVersion,
    ],
  )

  // Evidence is the row as PostgreSQL stored it, never the input echoed back.
  const inserted = await tx.unsafe(
    `SELECT reward_settlement_rail_id, environment, backend, chain_id, token_address,
        treasury_address, vault_address, operator_address, policy_version, status, created_at
      FROM reward_settlement_rails WHERE reward_settlement_rail_id = $1`,
    [plan.railId],
  )
  if (!inserted[0]) {
    throw new SettlementRailBootstrapError("read_back_failed", "inserted rail row could not be read back", {
      rail_id: plan.railId,
    })
  }
  return { outcome: "inserted", binding: bindingFromRow(inserted[0]) }
}

// The connection string never reaches argv or evidence output; this is the
// only shape of it that may be printed.
export function describeDatabaseTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl)
    return `${url.hostname}${url.pathname}`
  } catch {
    return "unparseable-database-url"
  }
}
