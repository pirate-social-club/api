import { badRequestError } from "../../../errors"
import type { FundingAcquisition, FundingSourceAcquireInput } from "./types"

// DEV-ONLY TON testnet acquisition. Proves the Telegram Wallet / TON Connect approval + bot UX
// loop and the async state machine — it is NOT real money and NOT a canonical funding receipt.
// On a verified TON testnet transfer it maps to a clearly-namespaced MOCK Base-Sepolia txRef
// (mock-base-sepolia:<tonTxHash>) so nothing can mistake it for a real EVM tx hash outside the
// dev verifier path. The real Base USDC verifier must NEVER see one of these.
export const MOCK_BASE_SEPOLIA_PREFIX = "mock-base-sepolia:"

export function isMockBaseSepoliaTxRef(ref: string): boolean {
  return ref.startsWith(MOCK_BASE_SEPOLIA_PREFIX)
}

export type TonTestnetTx = {
  hash: string
  toAddress: string
  amountNano: string
  // Comment/payload the wallet attached — must reference the spend intent so the tx is bound to it.
  payload?: string | null
}

export type TonTestnetClient = {
  getTransaction: (txHash: string) => Promise<TonTestnetTx | null>
}

export type TonTestnetExpectations = {
  spendIntentId: string
  expectedRecipient: string
  minAmountNano?: string | null
}

// Canonical, structured memo the wallet must attach. The verifier requires an EXACT match (not a
// substring) so an unrelated transfer/comment can never accidentally satisfy the binding. The
// spend_intent_id is a random per-intent id, so this also acts as the binding nonce.
export function expectedTonPayload(spendIntentId: string): string {
  return `pirate-spend:${spendIntentId}`
}

function normalizeTonAddress(value: string): string {
  return value.trim()
}

// Pure verification + mapping. Fixture-tested. Returns confirmed (mock txRef) only when the tx is
// to the expected recipient, references the spend intent in its payload, and meets the amount.
export function mapTonTestnetTxToAcquisition(
  tx: TonTestnetTx | null,
  input: FundingSourceAcquireInput,
  expectations: TonTestnetExpectations,
): FundingAcquisition {
  const sourceCorrelation = {
    kind: "ton_testnet" as const,
    routeRef: input.routeRef ?? null,
    sourceTxRef: tx?.hash ?? input.sourceTxRef ?? null,
  }

  if (!tx) {
    // Not observable yet — keep the poller alive without binding anything.
    return { status: "pending", sourceCorrelation }
  }

  const recipientOk = normalizeTonAddress(tx.toAddress) === normalizeTonAddress(expectations.expectedRecipient)
  // EXACT structured-memo match — never a loose substring.
  const payloadOk = (tx.payload ?? "").trim() === expectedTonPayload(expectations.spendIntentId)
  const amountOk =
    !expectations.minAmountNano || BigInt(tx.amountNano) >= BigInt(expectations.minAmountNano)

  if (!recipientOk || !payloadOk || !amountOk) {
    const reason = !recipientOk
      ? "ton tx recipient does not match"
      : !payloadOk
        ? "ton tx payload does not reference the spend intent"
        : "ton tx amount is too low"
    return { status: "failed", reason, refundable: true, sourceCorrelation }
  }

  const baseUsdcTxRef = `${MOCK_BASE_SEPOLIA_PREFIX}${tx.hash}`
  return {
    status: "confirmed",
    baseUsdcTxRef,
    sourceCorrelation: { ...sourceCorrelation, baseUsdcTxRef },
  }
}

// Build an acquisition resolver bound to per-intent expectations. The TON tx hash arrives via the
// acquire input's sourceTxRef.
export function createTonTestnetAcquisitionResolver(input: {
  client: TonTestnetClient
  expectations: TonTestnetExpectations
}): (acquireInput: FundingSourceAcquireInput) => Promise<FundingAcquisition> {
  return async (acquireInput) => {
    const txHash = acquireInput.sourceTxRef?.trim()
    if (!txHash) {
      throw badRequestError("ton_testnet_transfer acquisition requires the TON tx hash (sourceTxRef)")
    }
    const tx = await input.client.getTransaction(txHash)
    return mapTonTestnetTxToAcquisition(tx, acquireInput, input.expectations)
  }
}
