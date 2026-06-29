import type { Env } from "../../../../env"
import type { Client } from "../../../sql-client"
import type { CommunityRepository } from "../../db-community-repository"
import { badRequestError, notFoundError } from "../../../errors"
import { getSpendIntent, startSpendIntentFunding, type SpendIntentRow } from "./spend-intent"

// The "accept proposal + choose how to pay" action: proposed/approved -> funding_pending. This is
// pre-money — it records the chosen provider and returns wallet/payment instructions. No funds
// move and nothing is confirmed here (purchaseComplete/fundsMoved stay false throughout).

// Providers a user may SELECT here. omniston_ton is intentionally absent — it stays gated off
// until payout policy is decided. ton_testnet_transfer is dev-only (TON Connect approval/UX loop)
// and never a canonical funding receipt.
export type FundingProviderSelection = "pirate_checkout" | "ton_testnet_transfer"

export function selectFundingProvider(
  requested: string,
  options: { tonTestnetEnabled: boolean },
): FundingProviderSelection {
  if (requested === "pirate_checkout") {
    return "pirate_checkout"
  }
  if (requested === "ton_testnet_transfer") {
    if (!options.tonTestnetEnabled) {
      throw badRequestError("ton_testnet_transfer funding is not available in this environment")
    }
    return "ton_testnet_transfer"
  }
  if (requested === "omniston_ton") {
    throw badRequestError("omniston_ton funding is not yet available")
  }
  throw badRequestError("Unknown funding provider")
}

export type PaymentInstructions =
  | {
      provider: "pirate_checkout"
      kind: "evm_usdc"
      chainId: number
      tokenSymbol: "USDC"
      toAddress: string
      amountUsd: number
      note: string
    }
  | {
      provider: "ton_testnet_transfer"
      kind: "ton_testnet"
      toAddress: string
      amountTon: string
      // The EXACT memo the wallet must attach; the confirm step requires an exact match so an
      // unrelated transfer cannot satisfy the binding.
      comment: string
      // Explicitly labelled: TON testnet proves the wallet-approval/UX loop only; it is NOT a
      // canonical funding receipt. Real funding is still confirmed from a Base USDC txRef.
      testSimulation: true
      note: string
    }

export type AcceptProposalResult = {
  spendIntentId: string
  status: SpendIntentRow["status"]
  provider: FundingProviderSelection
  paymentInstructions: PaymentInstructions
  purchaseComplete: false
  fundsMoved: false
}

const PROPOSAL_ENTRY_STATES: ReadonlySet<SpendIntentRow["status"]> = new Set(["proposed", "approved"])

export async function acceptSpendIntentProposal(
  input: {
    controlPlaneClient: Client
    spendIntentId: string
    provider: FundingProviderSelection
    now: string
    authorize?: (intent: SpendIntentRow) => void | Promise<void>
  },
  deps: {
    buildPaymentInstructions: (input: {
      intent: SpendIntentRow
      provider: FundingProviderSelection
    }) => Promise<PaymentInstructions>
  },
): Promise<AcceptProposalResult> {
  const currentIntent = await getSpendIntent({
    client: input.controlPlaneClient,
    spendIntentId: input.spendIntentId,
  })
  if (!currentIntent) {
    throw badRequestError("Spend intent not found")
  }
  await input.authorize?.(currentIntent)
  if (!PROPOSAL_ENTRY_STATES.has(currentIntent.status)) {
    throw badRequestError("Spend intent cannot begin funding from its current state")
  }
  const paymentInstructions = await deps.buildPaymentInstructions({ intent: currentIntent, provider: input.provider })

  const intent = await startSpendIntentFunding({
    client: input.controlPlaneClient,
    spendIntentId: input.spendIntentId,
    provider: input.provider,
    now: input.now,
  })
  return {
    spendIntentId: intent.spend_intent_id,
    status: intent.status,
    provider: input.provider,
    paymentInstructions,
    purchaseComplete: false,
    fundsMoved: false,
  }
}

// Testable core of the "accept proposal" route. Authenticated mini-app user, intent-owner +
// community scoped (same discipline as confirm-funding). Injected deps keep it free of HMAC/DBs.
export type AcceptProposalRouteDeps = {
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
  tonTestnetEnabled: boolean
  acceptProposal: (input: {
    env: Env
    communityRepository: CommunityRepository
    spendIntentId: string
    provider: FundingProviderSelection
    now: string
    authorize?: (intent: SpendIntentRow) => void | Promise<void>
  }) => Promise<AcceptProposalResult>
}

export async function handleAcceptProposal(
  input: { env: Env; body: unknown; now: string },
  deps: AcceptProposalRouteDeps,
): Promise<AcceptProposalResult> {
  const body = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : {}
  const communityIdentifier = typeof body.community_id === "string" ? body.community_id.trim() : ""
  const initData = typeof body.init_data === "string" ? body.init_data.trim() : ""
  const spendIntentId = typeof body.spend_intent_id === "string" ? body.spend_intent_id.trim() : ""
  const requestedProvider = typeof body.provider === "string" ? body.provider.trim() : ""
  if (!communityIdentifier || !initData || !spendIntentId || !requestedProvider) {
    throw badRequestError("community_id, init_data, spend_intent_id, and provider are required")
  }

  // Validate + gate the provider before any auth/DB work.
  const provider = selectFundingProvider(requestedProvider, { tonTestnetEnabled: deps.tonTestnetEnabled })

  const communityRepository = deps.getCommunityRepository(input.env)
  const communityId = await deps.resolveCommunityId(communityRepository, communityIdentifier)
  if (!communityId) {
    throw badRequestError("Community was not found")
  }
  const telegramUser = await deps.verifyMiniAppUser({ env: input.env, communityId, initData })

  return await deps.acceptProposal({
    env: input.env,
    communityRepository,
    spendIntentId,
    provider,
    now: input.now,
    authorize: (loaded) => {
      // Intent owner AND the authed community must match the intent's community (also makes the
      // resolution invariant explicit). Not-found, never forbidden, to avoid leaking existence.
      if (loaded.telegram_user_id !== telegramUser.id || loaded.community_id !== communityId) {
        throw notFoundError("Spend intent not found")
      }
    },
  })
}
