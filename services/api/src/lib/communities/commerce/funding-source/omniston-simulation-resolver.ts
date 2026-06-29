import { badRequestError } from "../../../errors"
import type { FundingAcquisition, FundingSourceAcquireInput } from "./types"
import { expectedTonPayload } from "./ton-testnet-resolver"

// DEV/TEST ONLY: a simulated bridged TON -> Base USDC delivery. This models the two-leg
// attribution shape we need from a real bridge without calling STON.fi, Symbiosis, or the real
// Base verifier. Confirmed deliveries map to a namespaced mock Base ref that must never be treated
// as an on-chain receipt.
export const MOCK_OMNISTON_BASE_PREFIX = "mock-omniston-base:"

export function isMockOmnistonBaseTxRef(ref: string): boolean {
  return ref.startsWith(MOCK_OMNISTON_BASE_PREFIX)
}

export type SimulatedOmnistonRouteStatus =
  | "cancelled"
  | "delivered"
  | "failed"
  | "pending"
  | "underdelivered"

export type SimulatedOmnistonRoute = {
  routeRef: string
  sourceTxRef?: string | null
  sourcePayloadMode?: "pirate_memo" | "provider_generated"
  sourcePayload?: string | null
  destinationTxRef?: string | null
  deliveredBaseUsdcAtomic?: string | null
  status: SimulatedOmnistonRouteStatus
}

export type SimulatedSymbiosisTxStatus = {
  status?: { code?: number | null; text?: string | null } | null
  tx?: {
    hash?: string | null
    chainId?: number | null
    tokenAmount?: { amount?: string | null } | null
  } | null
  txIn?: {
    hash?: string | null
    chainId?: number | null
    tokenAmount?: { amount?: string | null } | null
  } | null
}

export type SimulatedOmnistonClient = {
  getRoute: (routeRef: string) => Promise<SimulatedOmnistonRoute | null>
}

export type SimulatedOmnistonExpectations = {
  spendIntentId: string
  minBaseUsdcAtomic: string
}

function positiveBigInt(value: string, field: string): bigint {
  try {
    const parsed = BigInt(value)
    if (parsed < 0n) {
      throw new Error("negative")
    }
    return parsed
  } catch {
    throw badRequestError(`Invalid simulated Omniston ${field}`)
  }
}

function sourceCorrelation(route: SimulatedOmnistonRoute | null, input: FundingSourceAcquireInput) {
  return {
    kind: "omniston_ton" as const,
    routeRef: route?.routeRef ?? input.routeRef ?? null,
    sourceTxRef: route?.sourceTxRef ?? input.sourceTxRef ?? null,
  }
}

export function mapSimulatedSymbiosisStatusToRoute(input: {
  routeRef: string
  status: SimulatedSymbiosisTxStatus | null
}): SimulatedOmnistonRoute | null {
  const status = input.status
  if (!status) return null

  const sourceTxRef = status.txIn?.hash?.trim() || null
  const destinationTxRef = status.tx?.hash?.trim() || null
  const deliveredBaseUsdcAtomic = status.tx?.tokenAmount?.amount?.trim() || null
  const code = status.status?.code

  if (code === 0) {
    return {
      routeRef: input.routeRef,
      sourceTxRef,
      sourcePayloadMode: "provider_generated",
      destinationTxRef,
      deliveredBaseUsdcAtomic,
      status: "delivered",
    }
  }

  if (code === 2 || code === 3) {
    return {
      routeRef: input.routeRef,
      sourceTxRef,
      sourcePayloadMode: "provider_generated",
      destinationTxRef,
      deliveredBaseUsdcAtomic,
      status: "failed",
    }
  }

  return {
    routeRef: input.routeRef,
    sourceTxRef,
    sourcePayloadMode: "provider_generated",
    destinationTxRef,
    deliveredBaseUsdcAtomic,
    status: "pending",
  }
}

export function mapSimulatedOmnistonRouteToAcquisition(
  route: SimulatedOmnistonRoute | null,
  input: FundingSourceAcquireInput,
  expectations: SimulatedOmnistonExpectations,
): FundingAcquisition {
  const correlation = sourceCorrelation(route, input)

  if (!route || route.status === "pending") {
    return { status: "pending", sourceCorrelation: correlation }
  }

  if (route.routeRef !== input.routeRef) {
    return {
      status: "failed",
      reason: "simulated Omniston route does not match",
      refundable: true,
      sourceCorrelation: correlation,
    }
  }

  const payloadMode = route.sourcePayloadMode ?? "pirate_memo"
  const payloadOk = payloadMode === "provider_generated"
    ? Boolean(route.sourceTxRef?.trim())
    : (route.sourcePayload ?? "").trim() === expectedTonPayload(expectations.spendIntentId)
  if (!payloadOk) {
    return {
      status: "failed",
      reason: payloadMode === "provider_generated"
        ? "simulated Omniston route is missing the source transaction"
        : "simulated Omniston source payload does not reference the spend intent",
      refundable: true,
      sourceCorrelation: correlation,
    }
  }

  if (route.status === "cancelled" || route.status === "failed") {
    return {
      status: "failed",
      reason: route.status === "cancelled" ? "simulated Omniston route cancelled" : "simulated Omniston route failed",
      refundable: true,
      sourceCorrelation: correlation,
    }
  }

  const delivered = positiveBigInt(route.deliveredBaseUsdcAtomic ?? "0", "delivered amount")
  const expected = positiveBigInt(expectations.minBaseUsdcAtomic, "expected amount")
  if (route.status === "underdelivered" || delivered < expected) {
    return {
      status: "failed",
      reason: "simulated Omniston Base delivery is below the expected amount",
      refundable: true,
      sourceCorrelation: correlation,
    }
  }

  const destinationTxRef = route.destinationTxRef?.trim()
  if (!destinationTxRef) {
    return {
      status: "pending",
      sourceCorrelation: correlation,
    }
  }

  const baseUsdcTxRef = `${MOCK_OMNISTON_BASE_PREFIX}${destinationTxRef}`
  return {
    status: "confirmed",
    baseUsdcTxRef,
    sourceCorrelation: {
      ...correlation,
      baseUsdcTxRef,
    },
  }
}

export function createSimulatedOmnistonAcquisitionResolver(input: {
  client: SimulatedOmnistonClient
  expectations: SimulatedOmnistonExpectations
}): (acquireInput: FundingSourceAcquireInput) => Promise<FundingAcquisition> {
  return async (acquireInput) => {
    const routeRef = acquireInput.routeRef?.trim()
    if (!routeRef) {
      throw badRequestError("simulated Omniston acquisition requires routeRef")
    }
    const route = await input.client.getRoute(routeRef)
    return mapSimulatedOmnistonRouteToAcquisition(route, acquireInput, input.expectations)
  }
}
