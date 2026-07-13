import { JsonRpcProvider } from "ethers"

export type RewardCampaignFinalityReceipt = {
  blockNumber: number
  blockHash: string
}

export type RewardCampaignFinalityProvider = {
  send(method: string, params: unknown[]): Promise<unknown>
  getTransactionReceipt(txHash: string): Promise<RewardCampaignFinalityReceipt | null>
  getBlock(blockNumber: number): Promise<{ hash: string | null } | null>
}

export type RewardCampaignFinalityResult =
  | { kind: "healthy" }
  | { kind: "definitive_loss"; reason: "confirmed_funding_receipt_not_canonical" }
  | { kind: "transient"; reason: string }

export function createRewardCampaignFinalityProvider(
  rpcUrl: string,
  chainId: number,
): RewardCampaignFinalityProvider {
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true })
  return {
    send: (method, params) => provider.send(method, params),
    getTransactionReceipt: async (txHash) => await provider.getTransactionReceipt(txHash),
    getBlock: async (blockNumber) => await provider.getBlock(blockNumber),
  }
}

function parseChainId(value: unknown): number | null {
  try {
    const parsed = typeof value === "string" ? Number(BigInt(value)) : Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

export async function verifyRewardCampaignFinalityChain(
  provider: RewardCampaignFinalityProvider,
  expectedChainId: number,
): Promise<boolean> {
  try {
    return parseChainId(await provider.send("eth_chainId", [])) === expectedChainId
  } catch {
    return false
  }
}

export async function checkRewardCampaignFundingFinality(input: {
  provider: RewardCampaignFinalityProvider
  txHash: string
  confirmedBlockNumber: number
  confirmedBlockHash: string
}): Promise<RewardCampaignFinalityResult> {
  const expectedHash = input.confirmedBlockHash.toLowerCase()
  try {
    // Fetch both pieces of evidence even when the receipt vanished. A changed canonical
    // block at the persisted height is definitive reorg evidence; a missing receipt with
    // the same canonical block remains ambiguous and must not create a hold.
    const [receipt, canonicalBlock] = await Promise.all([
      input.provider.getTransactionReceipt(input.txHash),
      input.provider.getBlock(input.confirmedBlockNumber),
    ])
    if (!canonicalBlock?.hash) {
      return { kind: "transient", reason: "canonical_block_unavailable" }
    }
    if (canonicalBlock.hash.toLowerCase() !== expectedHash) {
      return { kind: "definitive_loss", reason: "confirmed_funding_receipt_not_canonical" }
    }
    if (!receipt) {
      return { kind: "transient", reason: "confirmed_receipt_unavailable" }
    }
    if (
      receipt.blockNumber !== input.confirmedBlockNumber
      || receipt.blockHash.toLowerCase() !== expectedHash
    ) {
      return { kind: "definitive_loss", reason: "confirmed_funding_receipt_not_canonical" }
    }
    return { kind: "healthy" }
  } catch {
    return { kind: "transient", reason: "reward_campaign_rpc_unavailable" }
  }
}
