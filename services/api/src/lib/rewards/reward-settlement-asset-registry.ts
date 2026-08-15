import type { Env } from "../../env"
import { resolveRewardsSettlementOperatorAddress } from "../communities/bookings/booking-chain-config"
import { providerUnavailable } from "../errors"
import { getControlPlaneCacheKey } from "../runtime-deps"
import type { Client, Transaction } from "../sql-client"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import { resolveRewardsSettlementBackend } from "./reward-vault-lit-config"

// Reader for the control-plane settlement-asset registry (core migration
// 0236: reward_settlement_assets / reward_settlement_rails). Registry rows
// are written only by migrations and the admin bootstrap runbook — the API
// role holds SELECT alone — so this module is read-only by construction.
//
// Authority is gated by REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED. While
// the flag is off the registry has no effect on any request; the shadow
// module reads through this same cache for diagnostics. When the flag is on,
// registry evidence gates INITIATION of new economic commitments only —
// reconciliation, finality processing, and recovery of already-created
// effects run from their own snapshotted evidence and never call this gate.

export type SettlementRegistryAsset = {
  chainId: number
  tokenAddress: string
  decimals: number
  symbol: string
  denominationPolicy: string
  status: string
  quoteCutoffAt: string | null
}

export type SettlementRegistryRail = {
  railId: string
  environment: string
  backend: string
  chainId: number
  tokenAddress: string
  treasuryAddress: string
  vaultAddress: string | null
  operatorAddress: string
  policyVersion: string
}

export type SettlementRegistrySnapshot = {
  assets: SettlementRegistryAsset[]
  rails: SettlementRegistryRail[]
}

export type SettlementInitiationAsset = {
  chainId: number
  tokenAddress: string
  tokenDecimals: number
  tokenSymbol: string
}

export type ExpectedSettlementRailView = {
  environment: string
  backend: string | null
  treasuryAddress: string | null
  operatorAddress: string | null
  vaultAddress: string | null
}

export const EXPECTED_RAIL_POLICY_VERSION = "v1"

type RegistryExec = Pick<Client | Transaction, "execute">

export function settlementRegistryAuthorityEnabled(
  env: Pick<Env, "REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED">,
): boolean {
  return String(env.REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED ?? "").trim().toLowerCase() === "true"
}

export function resolveSettlementRegistryEnvironment(
  env: Pick<Env, "ENVIRONMENT">,
): "local" | "staging" | "production" {
  const value = String(env.ENVIRONMENT ?? "").trim().toLowerCase()
  return value === "staging" || value === "production" ? value : "local"
}

export function normalizeEvmAddressOrNull(raw: unknown): string | null {
  const value = String(raw ?? "").trim()
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null
}

// A stale registry row must not outlive an operator action for long, and an
// expired entry that fails to refresh is unavailable, never stale-served.
const REGISTRY_CACHE_TTL_MS = 60_000
const REGISTRY_CACHE_MAX_ENTRIES = 8

const registryCache = new Map<string, { snapshot: SettlementRegistrySnapshot; expiresAt: number }>()

export function clearSettlementRegistryCacheForTests(): void {
  registryCache.clear()
}

async function loadSnapshot(exec: RegistryExec): Promise<SettlementRegistrySnapshot> {
  const assetResult = await exec.execute({
    sql: `SELECT chain_id, token_address, decimals, symbol, denomination_policy, status, quote_cutoff_at
      FROM reward_settlement_assets`,
    args: [],
  })
  const railResult = await exec.execute({
    sql: `SELECT reward_settlement_rail_id, environment, backend, chain_id, token_address,
        treasury_address, vault_address, operator_address, policy_version
      FROM reward_settlement_rails WHERE status = 'active'`,
    args: [],
  })
  return {
    assets: assetResult.rows.map((row) => ({
      chainId: requiredNumber(row, "chain_id"),
      tokenAddress: requiredString(row, "token_address").toLowerCase(),
      decimals: requiredNumber(row, "decimals"),
      symbol: requiredString(row, "symbol"),
      denominationPolicy: requiredString(row, "denomination_policy"),
      status: requiredString(row, "status"),
      quoteCutoffAt: stringOrNull(rowValue(row, "quote_cutoff_at")),
    })),
    rails: railResult.rows.map((row) => ({
      railId: requiredString(row, "reward_settlement_rail_id"),
      environment: requiredString(row, "environment"),
      backend: requiredString(row, "backend"),
      chainId: requiredNumber(row, "chain_id"),
      tokenAddress: requiredString(row, "token_address").toLowerCase(),
      treasuryAddress: requiredString(row, "treasury_address").toLowerCase(),
      vaultAddress: normalizeEvmAddressOrNull(rowValue(row, "vault_address")),
      operatorAddress: requiredString(row, "operator_address").toLowerCase(),
      policyVersion: requiredString(row, "policy_version"),
    })),
  }
}

export async function readSettlementRegistrySnapshot(input: {
  env: Env
  exec: RegistryExec
}): Promise<SettlementRegistrySnapshot> {
  const cacheKey = getControlPlaneCacheKey(input.env)
  const cached = registryCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.snapshot
  if (cached) registryCache.delete(cacheKey)
  const snapshot = await loadSnapshot(input.exec)
  registryCache.set(cacheKey, { snapshot, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS })
  while (registryCache.size > REGISTRY_CACHE_MAX_ENTRIES) {
    const oldestKey = registryCache.keys().next().value
    if (oldestKey == null) break
    registryCache.delete(oldestKey)
  }
  return snapshot
}

export function findRegistryAsset(
  snapshot: SettlementRegistrySnapshot,
  chainId: number,
  tokenAddress: string,
): SettlementRegistryAsset | null {
  const token = tokenAddress.toLowerCase()
  return snapshot.assets.find((asset) => asset.chainId === chainId && asset.tokenAddress === token) ?? null
}

export function findActiveRegistryRail(
  snapshot: SettlementRegistrySnapshot,
  environment: string,
  chainId: number,
  tokenAddress: string,
): SettlementRegistryRail | null {
  const token = tokenAddress.toLowerCase()
  return (
    snapshot.rails.find(
      (rail) => rail.environment === environment && rail.chainId === chainId && rail.tokenAddress === token,
    ) ?? null
  )
}

// The expected view is assembled from today's env-derived configuration.
// Individual custody fields degrade to null when their resolver cannot run
// (for example no operator key in a local shell); the comparison layers
// decide whether a null is skippable (shadow) or disqualifying (authority).
export function resolveExpectedSettlementRailView(env: Env): ExpectedSettlementRailView {
  let backend: string | null = null
  try {
    backend = resolveRewardsSettlementBackend(env)
  } catch {
    backend = null
  }
  let operatorAddress: string | null = null
  try {
    // Derives the address from the configured signer; throws when no signer
    // is present in this isolate (for example a local shell).
    operatorAddress = resolveRewardsSettlementOperatorAddress(env).toLowerCase()
  } catch {
    operatorAddress = null
  }
  return {
    environment: resolveSettlementRegistryEnvironment(env),
    backend,
    treasuryAddress: normalizeEvmAddressOrNull(env.REWARDS_CAMPAIGN_TREASURY_ADDRESS),
    operatorAddress,
    vaultAddress: normalizeEvmAddressOrNull(env.REWARDS_TREASURY_VAULT_ADDRESS),
  }
}

function failClosed(message: string, reason: string, retryable: boolean): never {
  throw providerUnavailable(message, { reason }, retryable)
}

// Initiation gate. Callers are the three places a new economic commitment is
// created: campaign creation, funding quotes, and cashout submission. Flag
// off: complete no-op (no queries). Flag on: fail closed on registry outage,
// unadmitted/suspended/retired asset, descriptor drift, or rail drift.
export async function assertRegistryAllowsSettlementInitiation(input: {
  env: Env
  exec: RegistryExec
  asset: SettlementInitiationAsset
}): Promise<void> {
  if (!settlementRegistryAuthorityEnabled(input.env)) return

  let snapshot: SettlementRegistrySnapshot
  try {
    snapshot = await readSettlementRegistrySnapshot(input)
  } catch {
    failClosed("Reward settlement registry is unavailable", "registry_unreachable", true)
  }

  const asset = findRegistryAsset(snapshot, input.asset.chainId, input.asset.tokenAddress)
  if (!asset) {
    failClosed("Reward settlement asset is not admitted", "asset_not_admitted", false)
  }
  if (asset.status === "suspended") {
    failClosed("Reward settlement asset is suspended", "asset_suspended", false)
  }
  if (asset.status === "retired") {
    failClosed("Reward settlement asset is retired", "asset_retired", false)
  }
  if (asset.status !== "admitted") {
    failClosed("Reward settlement asset lifecycle state is unknown", "asset_status_unknown", false)
  }
  if (asset.denominationPolicy !== "usd_par") {
    failClosed("Reward settlement asset denomination policy is unsupported", "denomination_policy_unsupported", false)
  }
  if (asset.decimals !== input.asset.tokenDecimals || asset.symbol !== input.asset.tokenSymbol) {
    failClosed("Reward settlement asset descriptor does not match configuration", "asset_descriptor_mismatch", false)
  }

  const expected = resolveExpectedSettlementRailView(input.env)
  if (expected.backend === null || expected.treasuryAddress === null) {
    failClosed("Reward settlement configuration is unresolvable", "expected_config_unresolvable", false)
  }
  const rail = findActiveRegistryRail(snapshot, expected.environment, input.asset.chainId, input.asset.tokenAddress)
  if (!rail) {
    failClosed("Reward settlement rail is not bound for this environment", "rail_missing", false)
  }
  if (rail.backend !== expected.backend) {
    failClosed("Reward settlement rail backend does not match configuration", "rail_backend_mismatch", false)
  }
  if (rail.treasuryAddress !== expected.treasuryAddress) {
    failClosed("Reward settlement rail treasury does not match configuration", "rail_treasury_mismatch", false)
  }
  if (expected.operatorAddress !== null && rail.operatorAddress !== expected.operatorAddress) {
    failClosed("Reward settlement rail operator does not match configuration", "rail_operator_mismatch", false)
  }
  if (expected.vaultAddress !== null && rail.vaultAddress !== expected.vaultAddress) {
    failClosed("Reward settlement rail vault does not match configuration", "rail_vault_mismatch", false)
  }
  if (rail.policyVersion !== EXPECTED_RAIL_POLICY_VERSION) {
    failClosed("Reward settlement rail policy version is unexpected", "rail_policy_version_unexpected", false)
  }
}
