/**
 * Fetches the one coherent chain snapshot a settlement decision needs.
 *
 * The block timestamp is read from the RECEIPT'S OWN block hash, never from a
 * separately fetched latest block. This is enforced by construction rather than
 * by convention because a wrong timestamp does not fail loudly: it shifts the
 * computed epoch, so the deferral cross-check either rejects a correct deferral
 * as a configuration error — stranding the effect in reconciliation — or, if
 * the drift happens to land inside the right epoch, passes while proving
 * nothing.
 *
 * There is deliberately no code path here that can produce a timestamp from
 * anything but `receipt.blockHash`.
 */

import type { RewardVaultReceiptSnapshot } from "./reward-vault-receipt-decision"

/** Narrow provider surface. Exposes no way to ask for `latest`. */
export type RewardVaultReceiptProvider = {
  getTransactionReceipt(txHash: string): Promise<{
    status: number | null
    hash: string
    blockHash: string
    logs: readonly {
      address: string
      topics: readonly string[]
      data: string
      transactionHash: string
    }[]
  } | null>
  /** Block lookup BY HASH only — there is no height or tag overload. */
  getBlock(blockHash: string): Promise<{ timestamp: number } | null>
}

export type RewardVaultSnapshotResult =
  | { status: "snapshot"; snapshot: RewardVaultReceiptSnapshot }
  | { status: "unavailable"; reason: string }

export async function fetchRewardVaultReceiptSnapshot(
  provider: RewardVaultReceiptProvider,
  txHash: string,
): Promise<RewardVaultSnapshotResult> {
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt) return { status: "unavailable", reason: "transaction receipt is unavailable" }
  if (receipt.status === null || receipt.status === undefined) {
    return { status: "unavailable", reason: "transaction receipt carries no status" }
  }
  if (typeof receipt.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(receipt.blockHash)) {
    return { status: "unavailable", reason: "transaction receipt carries no canonical block hash" }
  }

  // BY the receipt's block hash. Never `latest`, never a height.
  const block = await provider.getBlock(receipt.blockHash)
  if (!block) {
    return { status: "unavailable", reason: "receipt block is unavailable by its own hash" }
  }
  if (!Number.isSafeInteger(block.timestamp) || block.timestamp < 0) {
    return { status: "unavailable", reason: "receipt block timestamp is not a safe integer" }
  }

  return {
    status: "snapshot",
    snapshot: {
      status: receipt.status,
      transactionHash: receipt.hash,
      blockHash: receipt.blockHash,
      blockTimestampSeconds: BigInt(block.timestamp),
      logs: receipt.logs,
    },
  }
}
