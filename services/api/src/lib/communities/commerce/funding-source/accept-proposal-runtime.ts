import { getControlPlaneClient, withRequestControlPlaneClients } from "../../../runtime-deps"
import { openCommunityDb } from "../../community-db-factory"
import { getPurchaseQuoteRow } from "../queries"
import {
  resolvePirateCheckoutOperatorAddress,
  resolvePirateCheckoutSourceChainId,
} from "../checkout-config"
import { badRequestError } from "../../../errors"
import type { Env } from "../../../../env"
import type { CommunityDatabaseBindingRepository } from "../../db-community-repository"
import {
  acceptSpendIntentProposal,
  type AcceptProposalResult,
  type FundingProviderSelection,
  type PaymentInstructions,
} from "./accept-proposal"
import { expectedTonPayload } from "./ton-testnet-resolver"
import type { SpendIntentRow } from "./spend-intent"

type TonTestnetEnv = {
  PIRATE_TON_TESTNET_RECIPIENT?: string
}

// Real payment-instruction builder: reads the resolved quote (community DB) for amount/recipient.
// pirate_checkout -> Base USDC instructions; ton_testnet_transfer -> TON testnet, clearly labelled
// as a simulation that is NOT a canonical funding receipt.
async function buildRealPaymentInstructions(input: {
  env: Env
  communityRepository: CommunityDatabaseBindingRepository
  intent: SpendIntentRow
  provider: FundingProviderSelection
}): Promise<PaymentInstructions> {
  const communityId = input.intent.community_id
  if (!communityId) {
    throw badRequestError("Spend intent is not resolved (community missing)")
  }
  if (input.provider === "ton_testnet_transfer") {
    const toAddress = (input.env as TonTestnetEnv).PIRATE_TON_TESTNET_RECIPIENT?.trim() || ""
    return {
      provider: "ton_testnet_transfer",
      kind: "ton_testnet",
      toAddress,
      amountTon: "0",
      // Exact memo the confirm step will require — attach verbatim.
      comment: expectedTonPayload(input.intent.spend_intent_id),
      testSimulation: true,
      note: "Approve the TON testnet transfer with the exact comment shown. This is a test funding simulation and is NOT a canonical funding receipt; real funding is confirmed only from a Base USDC transaction.",
    }
  }

  const quoteId = input.intent.quote_id
  if (!quoteId) {
    throw badRequestError("Spend intent is not resolved (quote missing)")
  }
  const db = await openCommunityDb(input.env, input.communityRepository, communityId)
  try {
    const quote = await getPurchaseQuoteRow(db.client, communityId, quoteId)
    if (!quote) {
      throw badRequestError("Purchase quote not found for spend intent")
    }
    if (input.provider === "pirate_checkout") {
      const chainId = resolvePirateCheckoutSourceChainId(input.env)
      const toAddress = quote.funding_destination_address || resolvePirateCheckoutOperatorAddress(input.env)
      return {
        provider: "pirate_checkout",
        kind: "evm_usdc",
        chainId,
        tokenSymbol: "USDC",
        toAddress,
        amountUsd: quote.final_price_usd,
        note: `Send ${quote.final_price_usd} USDC on chain ${chainId} to ${toAddress}.`,
      }
    }
    throw badRequestError("Unsupported funding provider")
  } finally {
    db.close()
  }
}

// Runtime entry: request-scoped control-plane client (gate #1), then accept the proposal.
export async function runAcceptSpendIntentProposal(input: {
  env: Env
  communityRepository: CommunityDatabaseBindingRepository
  spendIntentId: string
  provider: FundingProviderSelection
  now: string
  authorize?: (intent: SpendIntentRow) => void | Promise<void>
}): Promise<AcceptProposalResult> {
  return await withRequestControlPlaneClients(async () => {
    const controlPlaneClient = getControlPlaneClient(input.env)
    return await acceptSpendIntentProposal(
      {
        controlPlaneClient,
        spendIntentId: input.spendIntentId,
        provider: input.provider,
        now: input.now,
        authorize: input.authorize,
      },
      {
        buildPaymentInstructions: ({ intent, provider }) =>
          buildRealPaymentInstructions({
            env: input.env,
            communityRepository: input.communityRepository,
            intent,
            provider,
          }),
      },
    )
  })
}
