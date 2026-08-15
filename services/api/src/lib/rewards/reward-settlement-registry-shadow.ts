import type { Env } from "../../env"
import type { Client, Transaction } from "../sql-client"
import {
  EXPECTED_RAIL_POLICY_VERSION,
  type ExpectedSettlementRailView,
  findActiveRegistryRail,
  findRegistryAsset,
  readSettlementRegistrySnapshot,
  resolveExpectedSettlementRailView,
  type SettlementInitiationAsset,
  type SettlementRegistrySnapshot,
} from "./reward-settlement-asset-registry"

// Diagnostic shadow comparison between the settlement registry and today's
// env-derived configuration. Runs best-effort at the three initiation sites;
// a shadow failure must never affect the request (same rule as the
// nationality shadow evaluator). Emitted lines carry running totals since
// isolate start so rate limiting never hides the evidence counts the
// activation gate needs: totals.compared / totals.mismatched /
// totals.unavailable are cumulative, not per-line.
//
// Payloads contain only public material: addresses, statuses, counters.
// Never add keys, connection strings, or RPC URLs here.

export type SettlementRegistryShadowSite = "campaign_create" | "funding_quote" | "cashout"

export type SettlementRegistryShadowReason =
  | "asset_missing"
  | "asset_suspended"
  | "asset_retired"
  | "asset_status_unknown"
  | "denomination_policy_mismatch"
  | "decimals_mismatch"
  | "symbol_mismatch"
  | "rail_missing"
  | "rail_backend_mismatch"
  | "rail_treasury_mismatch"
  | "rail_operator_mismatch"
  | "rail_vault_mismatch"
  | "rail_policy_version_unexpected"

export type SettlementRegistryShadowResult = {
  outcome: "match" | "mismatch"
  environment: string
  mismatch_reasons: Partial<Record<SettlementRegistryShadowReason, number>>
  compared_fields: number
  skipped_fields: number
}

function increment(
  reasons: Partial<Record<SettlementRegistryShadowReason, number>>,
  reason: SettlementRegistryShadowReason,
): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1
}

export function compareSettlementRegistry(input: {
  snapshot: SettlementRegistrySnapshot
  expectedAsset: SettlementInitiationAsset
  expectedRail: ExpectedSettlementRailView
}): SettlementRegistryShadowResult {
  const reasons: Partial<Record<SettlementRegistryShadowReason, number>> = {}
  let compared = 0
  let skipped = 0

  const asset = findRegistryAsset(input.snapshot, input.expectedAsset.chainId, input.expectedAsset.tokenAddress)
  compared += 1
  if (!asset) {
    increment(reasons, "asset_missing")
  } else {
    compared += 3
    if (asset.status === "suspended") increment(reasons, "asset_suspended")
    else if (asset.status === "retired") increment(reasons, "asset_retired")
    else if (asset.status !== "admitted") increment(reasons, "asset_status_unknown")
    if (asset.denominationPolicy !== "usd_par") increment(reasons, "denomination_policy_mismatch")
    if (asset.decimals !== input.expectedAsset.tokenDecimals) increment(reasons, "decimals_mismatch")
    if (asset.symbol !== input.expectedAsset.tokenSymbol) increment(reasons, "symbol_mismatch")
  }

  const rail = findActiveRegistryRail(
    input.snapshot,
    input.expectedRail.environment,
    input.expectedAsset.chainId,
    input.expectedAsset.tokenAddress,
  )
  compared += 1
  if (!rail) {
    increment(reasons, "rail_missing")
  } else {
    for (const [field, expected, actual] of [
      ["rail_backend_mismatch", input.expectedRail.backend, rail.backend],
      ["rail_treasury_mismatch", input.expectedRail.treasuryAddress, rail.treasuryAddress],
      ["rail_operator_mismatch", input.expectedRail.operatorAddress, rail.operatorAddress],
      ["rail_vault_mismatch", input.expectedRail.vaultAddress, rail.vaultAddress],
    ] as const) {
      if (expected === null) {
        skipped += 1
        continue
      }
      compared += 1
      if (expected !== actual) increment(reasons, field)
    }
    compared += 1
    if (rail.policyVersion !== EXPECTED_RAIL_POLICY_VERSION) {
      increment(reasons, "rail_policy_version_unexpected")
    }
  }

  return {
    outcome: Object.keys(reasons).length === 0 ? "match" : "mismatch",
    environment: input.expectedRail.environment,
    mismatch_reasons: reasons,
    compared_fields: compared,
    skipped_fields: skipped,
  }
}

const SHADOW_EMIT_MIN_INTERVAL_MS = 60_000

const shadowTotals = { compared: 0, matched: 0, mismatched: 0, unavailable: 0 }
const lastEmittedAt = new Map<string, number>()

export function clearSettlementRegistryShadowStateForTests(): void {
  shadowTotals.compared = 0
  shadowTotals.matched = 0
  shadowTotals.mismatched = 0
  shadowTotals.unavailable = 0
  lastEmittedAt.clear()
}

function shouldEmit(key: string): boolean {
  const now = Date.now()
  const last = lastEmittedAt.get(key)
  if (last !== undefined && now - last < SHADOW_EMIT_MIN_INTERVAL_MS) return false
  lastEmittedAt.set(key, now)
  return true
}

export async function observeSettlementRegistryShadow(input: {
  env: Env
  exec: Pick<Client | Transaction, "execute">
  site: SettlementRegistryShadowSite
  asset: SettlementInitiationAsset
}): Promise<void> {
  try {
    const snapshot = await readSettlementRegistrySnapshot({ env: input.env, exec: input.exec })
    const result = compareSettlementRegistry({
      snapshot,
      expectedAsset: input.asset,
      expectedRail: resolveExpectedSettlementRailView(input.env),
    })
    shadowTotals.compared += 1
    if (result.outcome === "match") shadowTotals.matched += 1
    else shadowTotals.mismatched += 1
    if (shouldEmit(`${input.site}:${result.outcome}`)) {
      console.info(
        "[rewards] settlement registry shadow",
        JSON.stringify({ site: input.site, ...result, totals: { ...shadowTotals } }),
      )
    }
  } catch (error) {
    shadowTotals.unavailable += 1
    if (shouldEmit(`${input.site}:unavailable`)) {
      console.warn("[rewards] settlement registry shadow unavailable", {
        site: input.site,
        error: error instanceof Error ? error.message : String(error),
        totals: { ...shadowTotals },
      })
    }
  }
}
