import { describe, expect, test } from "bun:test"
import {
  checkRewardCampaignFundingFinality,
  type RewardCampaignFinalityProvider,
  verifyRewardCampaignFinalityChain,
} from "./reward-campaign-finality"

const EXPECTED_HASH = `0x${"1".repeat(64)}`
const CHANGED_HASH = `0x${"2".repeat(64)}`

function provider(input: {
  chainId?: unknown
  receipt?: { blockNumber: number; blockHash: string } | null
  blockHash?: string | null
} = {}): RewardCampaignFinalityProvider {
  return {
    send: async () => input.chainId ?? "0x14a34",
    getTransactionReceipt: async () => input.receipt === undefined
      ? { blockNumber: 123, blockHash: EXPECTED_HASH }
      : input.receipt,
    getBlock: async () => ({ hash: input.blockHash === undefined ? EXPECTED_HASH : input.blockHash }),
  }
}

describe("reward campaign finality", () => {
  test("proves the configured chain instead of trusting a static provider", async () => {
    expect(await verifyRewardCampaignFinalityChain(provider(), 84532)).toBe(true)
    expect(await verifyRewardCampaignFinalityChain(provider({ chainId: "0x1" }), 84532)).toBe(false)
  })

  test("classifies a vanished receipt with a replaced canonical block as definitive loss", async () => {
    const result = await checkRewardCampaignFundingFinality({
      provider: provider({ receipt: null, blockHash: CHANGED_HASH }),
      txHash: `0x${"a".repeat(64)}`,
      confirmedBlockNumber: 123,
      confirmedBlockHash: EXPECTED_HASH,
    })
    expect(result).toEqual({
      kind: "definitive_loss",
      reason: "confirmed_funding_receipt_not_canonical",
    })
  })

  test("keeps a vanished receipt ambiguous while its canonical block is unchanged", async () => {
    const result = await checkRewardCampaignFundingFinality({
      provider: provider({ receipt: null }),
      txHash: `0x${"b".repeat(64)}`,
      confirmedBlockNumber: 123,
      confirmedBlockHash: EXPECTED_HASH,
    })
    expect(result).toEqual({ kind: "transient", reason: "confirmed_receipt_unavailable" })
  })
})
