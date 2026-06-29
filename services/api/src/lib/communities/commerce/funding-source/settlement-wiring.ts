import type { Env } from "../../../../env"
import type { Client } from "../../../sql-client"
import { badRequestError } from "../../../errors"
import type { CommunityDatabaseBindingRepository } from "../../db-community-repository"
import type { PurchaseQuoteRow } from "../row-types"
import type { BuyerFundingReceipt } from "../funding-proof-service"
import { derivePurchaseIdForQuote } from "../purchase-settlement-ids"
import { buyerMatchesFields, userBuyer, walletBuyer, type BuyerIdentity } from "../buyer-identity"
import { advanceSpendIntentFunding, getSpendIntent, type SpendIntentRow } from "./spend-intent"

// Precondition gate run BEFORE binding a funding receipt. Mirrors settlement-service.ts's quote
// gates and, critically, validates that the intent's buyer is the quote's buyer — so a
// mis-bound intent can never record a confirmed buyer_funding_receipt for a different payer.
// confirmBuyerFundingForSettlement does not re-validate buyer identity on the confirmed-metadata
// fast path, so this check must happen here. Pure/read-only and exported for direct testing.
export function assertQuoteSettleableForSpendIntent(input: {
  intent: SpendIntentRow
  quote: PurchaseQuoteRow
  now: string
}): void {
  const { intent, quote } = input

  // Lifecycle gates.
  if (quote.status !== "active") {
    throw badRequestError("Purchase quote is not active")
  }
  const expiresMs = Date.parse(quote.expires_at)
  const nowMs = Date.parse(input.now)
  if (Number.isNaN(expiresMs) || Number.isNaN(nowMs)) {
    throw badRequestError("Purchase quote has an unparseable expiry")
  }
  if (expiresMs <= nowMs) {
    throw badRequestError("Purchase quote has expired")
  }

  // Funding configuration this slice supports: the verifier requires a routed quote, and this
  // slice settles pirate_checkout-routed quotes only.
  if (quote.funding_mode !== "routed") {
    throw badRequestError("Spend-intent settlement requires a routed quote")
  }
  if (quote.route_provider !== "pirate_checkout") {
    throw badRequestError("Spend-intent settlement supports pirate_checkout-routed quotes only")
  }

  // Buyer identity must match the quote's buyer.
  let buyer: BuyerIdentity
  if (quote.buyer_kind === "wallet") {
    if (!intent.buyer_address) {
      throw badRequestError("Spend intent has no buyer wallet for a wallet-buyer quote")
    }
    try {
      // walletBuyer normalizes exactly as quote creation did (getAddress -> lowercase, eip155).
      buyer = walletBuyer({ walletAddress: intent.buyer_address })
    } catch {
      throw badRequestError("Spend intent buyer wallet is not a valid address")
    }
  } else {
    if (!intent.user_id) {
      throw badRequestError("Spend intent has no resolved user for a user-buyer quote")
    }
    buyer = userBuyer(intent.user_id)
  }
  if (!buyerMatchesFields(buyer, quote)) {
    throw badRequestError("Spend intent buyer does not match the purchase quote buyer")
  }
}

// The cross-DB bridge. spend_intents lives in CONTROL-PLANE; the canonical buyer-funding
// settlement runs against the COMMUNITY DB. So we drive the funding state machine on the
// control-plane client and capture the community client inside the `settle` closure.
//
// This slice handles pirate_checkout only and no TON: acquireFunding for pirate_checkout is a
// thin adapter (the buyer already submitted the Base USDC tx), and `settle` is exactly
// confirmBuyerFundingForSettlement — the unchanged on-chain verification + receipt recording.
// The terminal state is funding_confirmed (NOT settled): this confirms+records the canonical
// buyer-funding receipt but does NOT complete the purchase (Story royalty payment, entitlement
// mint, purchase rows). The bot/runtime must not treat funding_confirmed as "asset unlocked".
// Full finalization and the 'settled' state are a later slice keyed off the recorded receipt.
//
// Collaborators are injected as TYPES only. The orchestrator deliberately does NOT statically
// import the community-DB factory or funding verifier (whose module graphs pull in the
// control-plane Postgres driver) — that keeps it unit-testable and free of incidental deps. Real
// implementations are bound in settlement-wiring-deps.ts.
type CommunityDbHandle = {
  client: Client
  close: () => void
}

export type SettleSpendIntentDeps = {
  openCommunityDb: (
    env: Env,
    repo: CommunityDatabaseBindingRepository,
    communityId: string,
  ) => Promise<CommunityDbHandle>
  getPurchaseQuoteRow: (
    client: Client,
    communityId: string,
    quoteId: string,
  ) => Promise<PurchaseQuoteRow | null>
  confirmBuyerFundingForSettlement: (input: {
    env: Env
    client: Client
    communityId: string
    quote: PurchaseQuoteRow
    purchaseId: string
    buyerAddress: string
    fundingTxRef: string
    now: string
  }) => Promise<BuyerFundingReceipt>
}

// States from which funding confirmation may (re)run. funding_pending is the first attempt;
// funded is a retry after a prior funding-confirmation failure (receipt already bound). Any
// other state (funding_confirming in-flight, funding_confirmed/settled done, failed/refundable)
// is rejected.
const FUNDABLE_ENTRY_STATES: ReadonlySet<SpendIntentRow["status"]> = new Set([
  "funding_pending",
  "funded",
])

export async function settlePirateCheckoutSpendIntent(
  input: {
    env: Env
    controlPlaneClient: Client
    communityRepository: CommunityDatabaseBindingRepository
    spendIntentId: string
    // The Base USDC tx the buyer already submitted via pirate checkout.
    fundingTxRef: string
    now: string
    // Authorization hook (e.g. intent-owner check). Called with the loaded intent before any
    // gate or DB work; throwing aborts. Kept as a callback so this orchestrator stays unaware of
    // the auth model (mini-app today, possibly others later).
    authorize?: (intent: SpendIntentRow) => void | Promise<void>
  },
  deps: SettleSpendIntentDeps,
): Promise<SpendIntentRow> {
  const intent = await getSpendIntent({
    client: input.controlPlaneClient,
    spendIntentId: input.spendIntentId,
  })
  if (!intent) {
    throw badRequestError("Spend intent not found")
  }
  // Authorization first — before leaking provider/state or doing any work.
  await input.authorize?.(intent)
  // Provider gate: this slice wires pirate_checkout only.
  if (intent.funding_source_provider !== "pirate_checkout") {
    throw badRequestError("Settlement wiring currently supports pirate_checkout only")
  }
  // State gate: only confirm funding from a fundable pre-confirmation state.
  if (!FUNDABLE_ENTRY_STATES.has(intent.status)) {
    throw badRequestError("Spend intent is not in a fundable state")
  }
  // Resolution gate: a not-yet-resolved intent cannot fund a purchase. Reject BEFORE opening any
  // community DB — there is nothing to settle against until the item resolves.
  const communityId = intent.community_id
  const quoteId = intent.quote_id
  const buyerAddress = intent.buyer_address
  if (!communityId || !quoteId || !buyerAddress) {
    throw badRequestError("Spend intent is not resolved (community, quote, or buyer address missing)")
  }

  const db = await deps.openCommunityDb(input.env, input.communityRepository, communityId)
  try {
    const quote = await deps.getPurchaseQuoteRow(db.client, communityId, quoteId)
    if (!quote) {
      throw badRequestError("Purchase quote not found for spend intent")
    }
    // Gate lifecycle + buyer identity before any receipt is bound or recorded.
    assertQuoteSettleableForSpendIntent({ intent, quote, now: input.now })
    const purchaseId = derivePurchaseIdForQuote(quote.quote_id)

    // Funding state machine on control-plane; settlement on the community DB via the closure.
    return await advanceSpendIntentFunding({
      client: input.controlPlaneClient,
      spendIntentId: input.spendIntentId,
      acquireInput: { provider: "pirate_checkout", fundingTxRef: input.fundingTxRef },
      now: input.now,
      settle: async (baseUsdcTxRef) => {
        await deps.confirmBuyerFundingForSettlement({
          env: input.env,
          client: db.client,
          communityId,
          quote,
          purchaseId,
          buyerAddress,
          fundingTxRef: baseUsdcTxRef,
          now: input.now,
        })
      },
    })
  } finally {
    db.close()
  }
}
