import type { RewardTicketPoolConfig } from "./reward-ticket-pool-config"

export const MEGAPOT_RANDOM_TICKET_BUYER_ABI = [
  "function buyTickets(uint256 _count, address _recipient, address[] _referrers, uint256[] _referralSplit, bytes32 _source)",
] as const

const FULL_REFERRAL_SPLIT = 1_000_000_000_000_000_000n

export type RewardTicketMegapotPurchasePlan = {
  contractAddress: string
  functionName: "buyTickets"
  abi: readonly string[]
  args: readonly [bigint, string, readonly [string] | [], readonly [bigint] | [], string]
  recipientAddress: string
  expectedDrawingId: string
}

function bytes32SourceTag(value: string): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length > 32) throw new Error("Megapot source tag exceeds bytes32")
  let hex = "0x"
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
  return `${hex}${"00".repeat(32 - bytes.length)}`
}

/**
 * Build the exact random-ticket purchase call. This is intentionally a data
 * builder: signing, nonce management, fee policy, and receipt reconciliation
 * remain in the worker, after the reservation transaction commits.
 */
export function buildRewardTicketMegapotPurchasePlan(input: {
  config: Pick<RewardTicketPoolConfig, "randomTicketBuyerAddress" | "custodyAddress" | "referrerAddress" | "sourceTag">
  ticketCount: number
  expectedDrawingId: string | bigint
}): RewardTicketMegapotPurchasePlan {
  if (!Number.isSafeInteger(input.ticketCount) || input.ticketCount < 1 || input.ticketCount > 10) {
    throw new Error("Megapot random purchase count must be between 1 and 10")
  }
  const expectedDrawingId = typeof input.expectedDrawingId === "bigint"
    ? input.expectedDrawingId.toString()
    : input.expectedDrawingId
  if (!/^\d+$/u.test(expectedDrawingId)) throw new Error("expected drawing id is invalid")

  return {
    contractAddress: input.config.randomTicketBuyerAddress,
    functionName: "buyTickets",
    abi: MEGAPOT_RANDOM_TICKET_BUYER_ABI,
    args: [
      BigInt(input.ticketCount),
      input.config.custodyAddress,
      [input.config.referrerAddress],
      [FULL_REFERRAL_SPLIT],
      bytes32SourceTag(input.config.sourceTag),
    ],
    recipientAddress: input.config.custodyAddress,
    expectedDrawingId,
  }
}
