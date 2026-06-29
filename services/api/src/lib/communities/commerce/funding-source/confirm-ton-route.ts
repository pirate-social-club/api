import type { Env } from "../../../../env"
import { badRequestError, notFoundError } from "../../../errors"
import type { CommunityRepository } from "../../db-community-repository"
import type { SpendIntentRow } from "./spend-intent"

// Testable core of the DEV-ONLY "observe TON testnet transfer and advance" route. Hidden unless
// TON testnet is enabled; authenticated mini-app user, intent-owner + community scoped. Returns
// the funding state (funding_confirmed | refundable | funding_pending) — never settled, never
// purchase-complete. Injected deps keep it free of HMAC/DBs/TON RPC.
export type ConfirmTonRouteDeps = {
  tonTestnetEnabled: boolean
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
  runConfirm: (input: {
    env: Env
    communityRepository: CommunityRepository
    spendIntentId: string
    tonTxHash: string
    now: string
    authorize?: (intent: SpendIntentRow) => void | Promise<void>
  }) => Promise<SpendIntentRow>
}

export type ConfirmTonResponse = {
  intentId: string
  status: SpendIntentRow["status"]
  purchaseComplete: false
  fundsMoved: false
}

export async function handleTonTestnetConfirm(
  input: { env: Env; body: unknown; now: string },
  deps: ConfirmTonRouteDeps,
): Promise<ConfirmTonResponse> {
  // Dev-only: when disabled the route behaves as if it does not exist.
  if (!deps.tonTestnetEnabled) {
    throw notFoundError("Not found")
  }

  const body = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : {}
  const communityIdentifier = typeof body.community_id === "string" ? body.community_id.trim() : ""
  const initData = typeof body.init_data === "string" ? body.init_data.trim() : ""
  const spendIntentId = typeof body.spend_intent_id === "string" ? body.spend_intent_id.trim() : ""
  const tonTxHash = typeof body.ton_tx_hash === "string" ? body.ton_tx_hash.trim() : ""
  if (!communityIdentifier || !initData || !spendIntentId || !tonTxHash) {
    throw badRequestError("community_id, init_data, spend_intent_id, and ton_tx_hash are required")
  }

  const communityRepository = deps.getCommunityRepository(input.env)
  const communityId = await deps.resolveCommunityId(communityRepository, communityIdentifier)
  if (!communityId) {
    throw badRequestError("Community was not found")
  }
  const telegramUser = await deps.verifyMiniAppUser({ env: input.env, communityId, initData })

  const intent = await deps.runConfirm({
    env: input.env,
    communityRepository,
    spendIntentId,
    tonTxHash,
    now: input.now,
    authorize: (loaded) => {
      if (loaded.telegram_user_id !== telegramUser.id || loaded.community_id !== communityId) {
        throw notFoundError("Spend intent not found")
      }
    },
  })

  return {
    intentId: intent.spend_intent_id,
    status: intent.status,
    purchaseComplete: false,
    fundsMoved: false,
  }
}
