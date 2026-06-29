import type { Env } from "../../../../env"
import type { Client } from "../../../sql-client"
import type { CommunityDatabaseBindingRepository } from "../../db-community-repository"
import type { SpendIntentRow } from "./spend-intent"

// Runtime entry point for the funding bridge. Its one job is review gate #1: the control-plane
// Postgres client must be CREATED and USED entirely inside withRequestControlPlaneClients —
// getControlPlaneClient throws for Postgres URLs otherwise, and a client leaked outside the
// scope would exhaust connection slots. Everything downstream (spend_intents reads/writes, the
// community-DB settlement) runs within the scope and finishes before it closes.
//
// Collaborators are injected as structural types so this stays unit-testable without importing
// runtime-deps (whose graph pulls the Postgres driver). Real binding: settlement-runtime-deps.ts.
export type SpendIntentRuntimeDeps = {
  withRequestControlPlaneClients: <T>(operation: () => Promise<T>) => Promise<T>
  getControlPlaneClient: (env: Env) => Client
  settlePirateCheckoutSpendIntent: (input: {
    env: Env
    controlPlaneClient: Client
    communityRepository: CommunityDatabaseBindingRepository
    spendIntentId: string
    fundingTxRef: string
    now: string
    authorize?: (intent: SpendIntentRow) => void | Promise<void>
  }) => Promise<SpendIntentRow>
}

export async function runSettlePirateCheckoutSpendIntent(
  input: {
    env: Env
    communityRepository: CommunityDatabaseBindingRepository
    spendIntentId: string
    fundingTxRef: string
    now: string
    authorize?: (intent: SpendIntentRow) => void | Promise<void>
  },
  deps: SpendIntentRuntimeDeps,
): Promise<SpendIntentRow> {
  return await deps.withRequestControlPlaneClients(async () => {
    const controlPlaneClient = deps.getControlPlaneClient(input.env)
    return await deps.settlePirateCheckoutSpendIntent({
      env: input.env,
      controlPlaneClient,
      communityRepository: input.communityRepository,
      spendIntentId: input.spendIntentId,
      fundingTxRef: input.fundingTxRef,
      now: input.now,
      authorize: input.authorize,
    })
  })
}
