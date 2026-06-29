import type { Client } from "../../../sql-client"
import { badRequestError } from "../../../errors"
import { advanceSpendIntentFunding, getSpendIntent, type SpendIntentRow } from "./spend-intent"
import {
  createSimulatedOmnistonAcquisitionResolver,
  isMockOmnistonBaseTxRef,
  type SimulatedOmnistonClient,
} from "./omniston-simulation-resolver"

const FUNDABLE_STATES: ReadonlySet<SpendIntentRow["status"]> = new Set(["funding_pending", "funded"])

// DEV/TEST ONLY: drives an omniston_ton intent through the bridged-funding state machine using
// simulated route evidence. This never calls the real Base verifier and must never accept a real
// Base tx ref; it proves lifecycle/correlation/idempotency only.
export async function confirmSimulatedOmnistonFunding(input: {
  controlPlaneClient: Client
  spendIntentId: string
  routeRef: string
  minBaseUsdcAtomic: string
  now: string
  authorize?: (intent: SpendIntentRow) => void | Promise<void>
}, deps: {
  client: SimulatedOmnistonClient
}): Promise<SpendIntentRow> {
  const intent = await getSpendIntent({
    client: input.controlPlaneClient,
    spendIntentId: input.spendIntentId,
  })
  if (!intent) {
    throw badRequestError("Spend intent not found")
  }
  await input.authorize?.(intent)
  if (intent.funding_source_provider !== "omniston_ton") {
    throw badRequestError("Spend intent is not an omniston_ton intent")
  }
  if (!FUNDABLE_STATES.has(intent.status)) {
    throw badRequestError("Spend intent is not in a fundable state")
  }

  const resolveAcquisition = createSimulatedOmnistonAcquisitionResolver({
    client: deps.client,
    expectations: {
      spendIntentId: input.spendIntentId,
      minBaseUsdcAtomic: input.minBaseUsdcAtomic,
    },
  })

  return await advanceSpendIntentFunding({
    client: input.controlPlaneClient,
    spendIntentId: input.spendIntentId,
    acquireInput: { provider: "omniston_ton", routeRef: input.routeRef },
    now: input.now,
    resolveAcquisition,
    settle: async (baseUsdcTxRef) => {
      if (!isMockOmnistonBaseTxRef(baseUsdcTxRef)) {
        throw new Error("simulated Omniston dev settle received a non-mock funding ref")
      }
    },
  })
}
