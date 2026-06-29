import { getControlPlaneClient, withRequestControlPlaneClients } from "../../../runtime-deps"
import { settlePirateCheckoutSpendIntent } from "./settlement-wiring"
import { realSettleSpendIntentDeps } from "./settlement-wiring-deps"
import type { SpendIntentRuntimeDeps } from "./settlement-runtime"

// Real binding of the runtime entry point's collaborators. Kept separate so the orchestrator
// (and its unit test) does not import runtime-deps / the community-DB factory graphs. A route
// handler / runtime caller imports THIS and passes it to runSettlePirateCheckoutSpendIntent.
export const realSpendIntentRuntimeDeps: SpendIntentRuntimeDeps = {
  withRequestControlPlaneClients,
  getControlPlaneClient,
  settlePirateCheckoutSpendIntent: (input) =>
    settlePirateCheckoutSpendIntent(input, realSettleSpendIntentDeps),
}
