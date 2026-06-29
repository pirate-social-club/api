import { openCommunityDb } from "../../community-db-factory"
import { getPurchaseQuoteRow } from "../queries"
import { confirmBuyerFundingForSettlement } from "../funding-proof-service"
import type { SettleSpendIntentDeps } from "./settlement-wiring"

// Real composition of settlePirateCheckoutSpendIntent's collaborators. Kept separate from the
// orchestrator so importing the orchestrator (and unit-testing it) does not pull in the
// community-DB factory / funding verifier module graphs. The route handler / runtime wiring
// imports THIS and passes it as the deps argument.
export const realSettleSpendIntentDeps: SettleSpendIntentDeps = {
  openCommunityDb,
  getPurchaseQuoteRow,
  confirmBuyerFundingForSettlement,
}
