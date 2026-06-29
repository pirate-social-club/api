import type { Env } from "../../../../env"
import type { CommunityRepository } from "../../db-community-repository"
import type { SpendIntentRow } from "./spend-intent"
import { badRequestError, notFoundError } from "../../../errors"

// Testable core of the "confirm funding" route. Authenticated mini-app user only; intent-owner
// authorization; funding-confirmation only (never implies purchase completion). Collaborators
// are injected so this is unit-testable without HMAC verification or live DBs.
export type ConfirmFundingDeps = {
  getCommunityRepository: (env: Env) => CommunityRepository
  resolveCommunityId: (
    repo: CommunityRepository,
    identifier: string,
  ) => Promise<string | null>
  verifyMiniAppUser: (args: {
    env: Env
    communityId: string
    initData: string
  }) => Promise<{ id: string }> | { id: string }
  runSettle: (input: {
    env: Env
    communityRepository: CommunityRepository
    spendIntentId: string
    fundingTxRef: string
    now: string
    authorize?: (intent: SpendIntentRow) => void | Promise<void>
  }) => Promise<SpendIntentRow>
}

export type ConfirmFundingResponse = {
  intentId: string
  status: SpendIntentRow["status"]
  // Review gate #2: this route confirms funding only — it NEVER completes a purchase. So this is
  // always false and the response carries no entitlement/unlock fields. The later finalization
  // slice is the only place that may report purchaseComplete: true.
  purchaseComplete: false
}

export async function handleConfirmSpendIntentFunding(
  input: { env: Env; body: unknown; now: string },
  deps: ConfirmFundingDeps,
): Promise<ConfirmFundingResponse> {
  const body = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : {}
  const communityIdentifier = typeof body.community_id === "string" ? body.community_id.trim() : ""
  const initData = typeof body.init_data === "string" ? body.init_data.trim() : ""
  const spendIntentId = typeof body.spend_intent_id === "string" ? body.spend_intent_id.trim() : ""
  const fundingTxRef = typeof body.funding_tx_ref === "string" ? body.funding_tx_ref.trim() : ""
  if (!communityIdentifier || !initData || !spendIntentId || !fundingTxRef) {
    throw badRequestError("community_id, init_data, spend_intent_id, and funding_tx_ref are required")
  }

  const communityRepository = deps.getCommunityRepository(input.env)
  const communityId = await deps.resolveCommunityId(communityRepository, communityIdentifier)
  if (!communityId) {
    throw badRequestError("Community was not found")
  }
  // Verify the mini-app init data against the community's bot token(s).
  const telegramUser = await deps.verifyMiniAppUser({ env: input.env, communityId, initData })

  const intent = await deps.runSettle({
    env: input.env,
    communityRepository,
    spendIntentId,
    fundingTxRef,
    now: input.now,
    authorize: (loaded) => {
      // Intent-owner authorization, AND the authenticated community (whose bot tokens verified
      // the init data) must be the intent's community. This also makes the resolution invariant
      // explicit: a pre-community intent (community_id null) can never be confirmed here. Use
      // not-found (not forbidden) throughout so a non-owner cannot probe intent existence.
      if (loaded.telegram_user_id !== telegramUser.id || loaded.community_id !== communityId) {
        throw notFoundError("Spend intent not found")
      }
    },
  })

  return {
    intentId: intent.spend_intent_id,
    status: intent.status,
    purchaseComplete: false,
  }
}
