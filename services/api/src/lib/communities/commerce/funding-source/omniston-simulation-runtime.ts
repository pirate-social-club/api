import { getControlPlaneClient, withRequestControlPlaneClients } from "../../../runtime-deps"
import type { Env } from "../../../../env"
import type { CommunityRepository } from "../../db-community-repository"
import { startSpendIntentFunding, type SpendIntentRow } from "./spend-intent"
import { confirmSimulatedOmnistonFunding } from "./omniston-simulation-confirm"
import type { SimulatedOmnistonRoute } from "./omniston-simulation-resolver"

export async function runStartSimulatedOmnistonFunding(input: {
  env: Env
  communityRepository: CommunityRepository
  spendIntentId: string
  now: string
  authorize?: (intent: SpendIntentRow) => void | Promise<void>
}): Promise<SpendIntentRow> {
  void input.communityRepository
  return await withRequestControlPlaneClients(async () => {
    const controlPlaneClient = getControlPlaneClient(input.env)
    return await startSpendIntentFunding({
      client: controlPlaneClient,
      spendIntentId: input.spendIntentId,
      provider: "omniston_ton",
      now: input.now,
      authorize: input.authorize,
    })
  })
}

export async function runConfirmSimulatedOmnistonFunding(input: {
  env: Env
  communityRepository: CommunityRepository
  spendIntentId: string
  routeRef: string
  minBaseUsdcAtomic: string
  simulatedRoute: SimulatedOmnistonRoute | null
  now: string
  authorize?: (intent: SpendIntentRow) => void | Promise<void>
}): Promise<SpendIntentRow> {
  void input.communityRepository
  return await withRequestControlPlaneClients(async () => {
    const controlPlaneClient = getControlPlaneClient(input.env)
    return await confirmSimulatedOmnistonFunding(
      {
        controlPlaneClient,
        spendIntentId: input.spendIntentId,
        routeRef: input.routeRef,
        minBaseUsdcAtomic: input.minBaseUsdcAtomic,
        now: input.now,
        authorize: input.authorize,
      },
      {
        client: {
          getRoute: async (routeRef) =>
            input.simulatedRoute?.routeRef === routeRef ? input.simulatedRoute : null,
        },
      },
    )
  })
}
