import type { Client } from "../../../sql-client"
import { badRequestError } from "../../../errors"
import { advanceSpendIntentFunding, getSpendIntent, type SpendIntentRow } from "./spend-intent"
import {
  createTonTestnetAcquisitionResolver,
  isMockBaseSepoliaTxRef,
  type TonTestnetClient,
} from "./ton-testnet-resolver"

const FUNDABLE_STATES: ReadonlySet<SpendIntentRow["status"]> = new Set(["funding_pending", "funded"])

// DEV-ONLY: observe a TON testnet transfer for a ton_testnet_transfer intent, verify it against
// the intent (recipient / payload / amount), map to a clearly-namespaced mock Base-Sepolia
// receipt, and drive the SAME funding state machine to funding_confirmed (or refundable). It
// never reaches `settled` and never touches the real Base USDC verifier — the mock ref is
// namespaced and the dev settle closure refuses any non-mock ref.
export async function confirmTonTestnetFunding(
  input: {
    controlPlaneClient: Client
    spendIntentId: string
    tonTxHash: string
    expectedRecipient: string
    minAmountNano?: string | null
    now: string
    authorize?: (intent: SpendIntentRow) => void | Promise<void>
  },
  deps: { tonClient: TonTestnetClient },
): Promise<SpendIntentRow> {
  const intent = await getSpendIntent({
    client: input.controlPlaneClient,
    spendIntentId: input.spendIntentId,
  })
  if (!intent) {
    throw badRequestError("Spend intent not found")
  }
  await input.authorize?.(intent)
  if (intent.funding_source_provider !== "ton_testnet_transfer") {
    throw badRequestError("Spend intent is not a ton_testnet_transfer intent")
  }
  if (!FUNDABLE_STATES.has(intent.status)) {
    throw badRequestError("Spend intent is not in a fundable state")
  }

  const resolveAcquisition = createTonTestnetAcquisitionResolver({
    client: deps.tonClient,
    expectations: {
      spendIntentId: input.spendIntentId,
      expectedRecipient: input.expectedRecipient,
      minAmountNano: input.minAmountNano ?? null,
    },
  })

  return await advanceSpendIntentFunding({
    client: input.controlPlaneClient,
    spendIntentId: input.spendIntentId,
    acquireInput: { provider: "ton_testnet_transfer", sourceTxRef: input.tonTxHash },
    now: input.now,
    resolveAcquisition,
    settle: async (baseUsdcTxRef) => {
      // Dev-only sink: the mock Base ref is not a real EVM tx, so there is nothing to verify
      // on-chain — the TON observation already confirmed test funds. This MUST never run for a
      // real funding ref; guard defensively so a real ref can never be confirmed here.
      if (!isMockBaseSepoliaTxRef(baseUsdcTxRef)) {
        throw new Error("ton-testnet dev settle received a non-mock funding ref")
      }
    },
  })
}
