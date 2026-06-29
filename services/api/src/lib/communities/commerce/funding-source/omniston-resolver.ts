import { badRequestError } from "../../../errors"
import type { OmnistonAcquisitionResolver } from "./acquisition"
import type { FundingAcquisition, FundingSourceAcquireInput } from "./types"

// Omniston cross-chain adapter (USDT-on-TON -> USDC-on-Base). Omniston has NO testnet, so the
// shapes below are our modeling of its route lifecycle, recorded-mainnet-shaped, to be reconciled
// with the real Omniston API/SDK at integration. The protocol guarantees exact-out or full
// refund ("users receive the exact amount shown ... otherwise funds return in full"), which maps
// cleanly onto confirmed / failed-refundable.
//
// This resolver only PRODUCES a Base USDC tx ref (or pending/failed). The canonical receipt is
// still derived by on-chain verification of that tx downstream — Omniston is never on the trust
// path, only the discovery path.
export type OmnistonRouteStatus = {
  routeId: string
  // pending: still executing; filled: destination delivered; refunded/failed: funds returned.
  state: "pending" | "filled" | "refunded" | "failed"
  // The destination (Base) USDC tx hash — present only when filled.
  destinationTxHash?: string | null
  reason?: string | null
}

export type OmnistonClient = {
  // Look up a cross-chain route/order by id (the routeRef carried on the spend intent).
  getRouteStatus: (routeId: string) => Promise<OmnistonRouteStatus>
}

// Pure mapping: Omniston route status -> funding acquisition state. Fixture-tested.
export function mapOmnistonRouteStatusToAcquisition(
  status: OmnistonRouteStatus,
  input: FundingSourceAcquireInput,
): FundingAcquisition {
  const sourceCorrelation = {
    kind: "omniston_ton" as const,
    routeRef: status.routeId,
    sourceTxRef: input.sourceTxRef ?? null,
  }

  switch (status.state) {
    case "filled": {
      const baseUsdcTxRef = status.destinationTxHash?.trim()
      if (!baseUsdcTxRef) {
        // Filled but no destination tx is inconsistent — treat as pending so we NEVER bind a
        // missing/empty receipt.
        return { status: "pending", sourceCorrelation }
      }
      return {
        status: "confirmed",
        baseUsdcTxRef,
        sourceCorrelation: { ...sourceCorrelation, baseUsdcTxRef },
      }
    }
    case "pending":
      return { status: "pending", sourceCorrelation }
    case "refunded":
      return {
        status: "failed",
        reason: status.reason?.trim() || "omniston route refunded",
        refundable: true,
        sourceCorrelation,
      }
    case "failed":
      return {
        status: "failed",
        reason: status.reason?.trim() || "omniston route failed",
        refundable: true,
        sourceCorrelation,
      }
    default:
      // Unknown state — never confirm. Pending keeps the poller alive without binding.
      return { status: "pending", sourceCorrelation }
  }
}

export function createOmnistonAcquisitionResolver(client: OmnistonClient): OmnistonAcquisitionResolver {
  return async (input: FundingSourceAcquireInput) => {
    const routeRef = input.routeRef?.trim()
    if (!routeRef) {
      throw badRequestError("omniston_ton acquisition requires a routeRef")
    }
    const status = await client.getRouteStatus(routeRef)
    return mapOmnistonRouteStatusToAcquisition(status, input)
  }
}

// --- Config gate: live Omniston is real money on mainnet (no testnet). DISABLED unless an
// explicit env flag is set, so it can never run by accident outside a deliberate environment. ---
export type OmnistonEnv = {
  PIRATE_OMNISTON_LIVE_ENABLED?: string
  PIRATE_OMNISTON_API_URL?: string
  PIRATE_OMNISTON_API_KEY?: string
}

export function isLiveOmnistonEnabled(env: OmnistonEnv): boolean {
  return env.PIRATE_OMNISTON_LIVE_ENABLED?.trim() === "true"
}

// Returns a live resolver ONLY when explicitly enabled AND configured; otherwise null. Callers
// must treat null as "omniston_ton funding is unavailable in this environment" (no real money).
// The client factory is injected so the real HTTP/SDK client is supplied at the wiring point.
export function resolveLiveOmnistonResolver(
  env: OmnistonEnv,
  createClient: (config: { apiUrl: string; apiKey: string }) => OmnistonClient,
): OmnistonAcquisitionResolver | null {
  if (!isLiveOmnistonEnabled(env)) {
    return null
  }
  const apiUrl = env.PIRATE_OMNISTON_API_URL?.trim()
  const apiKey = env.PIRATE_OMNISTON_API_KEY?.trim()
  if (!apiUrl || !apiKey) {
    throw badRequestError(
      "Live Omniston is enabled but PIRATE_OMNISTON_API_URL / PIRATE_OMNISTON_API_KEY are not configured",
    )
  }
  return createOmnistonAcquisitionResolver(createClient({ apiUrl, apiKey }))
}
