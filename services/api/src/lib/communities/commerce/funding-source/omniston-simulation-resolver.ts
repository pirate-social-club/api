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
  sourcePayload?: string | null
  destinationTxRef?: string | null
  deliveredBaseUsdcAtomic?: string | null
  status: SimulatedOmnistonRouteStatus
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

  const payloadOk = (route.sourcePayload ?? "").trim() === expectedTonPayload(expectations.spendIntentId)
  if (!payloadOk) {
    return {
      status: "failed",
      reason: "simulated Omniston source payload does not reference the spend intent",
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
