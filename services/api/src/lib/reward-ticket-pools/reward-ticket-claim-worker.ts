import { Interface, getAddress } from "ethers"

import { REWARD_TICKET_SAFE_CLAIM_MODULE_ABI } from "./megapot-abi"
import { isMegapotNoTicketsToClaim, isMegapotNotTicketOwner } from "./megapot-claim-policy"
import { normalizeMegapotOperationId } from "./megapot-operation-id"

const USDC = new Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"])
const SAFE_CLAIM_MODULE = new Interface(REWARD_TICKET_SAFE_CLAIM_MODULE_ABI)

export function buildRewardTicketSafeClaimCall(input: Readonly<{
  moduleAddress: string
  operationId: string
  ticketIds: readonly bigint[]
}>): Readonly<{ to: string; data: string; value: 0n }> {
  const moduleAddress = getAddress(input.moduleAddress)
  if (input.ticketIds.length === 0) throw new Error("reward_ticket_claim_batch_empty")
  if (input.ticketIds.some((ticketId) => ticketId < 0n)) {
    throw new Error("reward_ticket_claim_ticket_id_invalid")
  }
  return {
    to: moduleAddress,
    data: SAFE_CLAIM_MODULE.encodeFunctionData("claim", [
      normalizeMegapotOperationId(input.operationId),
      input.ticketIds,
    ]),
    value: 0n,
  }
}

export type RewardTicketClaimReceipt = Readonly<{
  status: number | null
  blockNumber: number
  blockHash: string
  logs: readonly Readonly<{ address: string; topics: readonly string[]; data: string }>[]
}>

function sameAddress(left: string, right: string): boolean {
  try { return getAddress(left) === getAddress(right) } catch { return false }
}

export function verifyRewardTicketClaimReceipt(input: Readonly<{
  receipt: RewardTicketClaimReceipt
  usdcAddress: string
  custodyAddress: string
  protocolReportedWinningsAtomic: bigint
}>): Readonly<{
  disposition: "confirmed"
  receivedAmountAtomic: bigint
}> | Readonly<{
  disposition: "needs_review"
  reason: "transaction_reverted" | "missing_or_invalid_usdc_receipt" | "receipt_amount_mismatch"
}> {
  if (input.receipt.status !== 1) return { disposition: "needs_review", reason: "transaction_reverted" }
  let receivedAmountAtomic = 0n
  let transferCount = 0
  for (const log of input.receipt.logs) {
    if (!sameAddress(log.address, input.usdcAddress)) continue
    try {
      const parsed = USDC.parseLog({ topics: [...log.topics], data: log.data })
      if (parsed?.name === "Transfer" && sameAddress(String(parsed.args.to), input.custodyAddress)) {
        receivedAmountAtomic += BigInt(parsed.args.value)
        transferCount += 1
      }
    } catch { /* unrelated USDC log */ }
  }
  if (transferCount === 0 || receivedAmountAtomic <= 0n) {
    return { disposition: "needs_review", reason: "missing_or_invalid_usdc_receipt" }
  }
  if (receivedAmountAtomic !== input.protocolReportedWinningsAtomic) {
    return { disposition: "needs_review", reason: "receipt_amount_mismatch" }
  }
  return { disposition: "confirmed", receivedAmountAtomic }
}

export function verifyRewardTicketClaimAccounting(input: Readonly<{
  grossTierPayoutAtomic: bigint
  claimEventWinningsAtomic: bigint
  custodyTransferAtomic: bigint
  referralAccrualDeltaAtomic: bigint
}>): Readonly<{
  beneficiaryProceedsAtomic: bigint
  platformReferralRevenueAtomic: bigint
}> {
  if (
    input.grossTierPayoutAtomic <= 0n
    || input.claimEventWinningsAtomic <= 0n
    || input.custodyTransferAtomic !== input.claimEventWinningsAtomic
    || input.referralAccrualDeltaAtomic < 0n
    || input.claimEventWinningsAtomic + input.referralAccrualDeltaAtomic !== input.grossTierPayoutAtomic
  ) {
    throw new Error("reward_ticket_claim_accounting_mismatch")
  }
  return {
    beneficiaryProceedsAtomic: input.custodyTransferAtomic,
    platformReferralRevenueAtomic: input.referralAccrualDeltaAtomic,
  }
}

export function classifyRewardTicketClaimSubmissionError(error: unknown): Readonly<{
  disposition: "no_claimable_value" | "needs_review" | "retry_later"
}> {
  if (isMegapotNoTicketsToClaim(error)) return { disposition: "no_claimable_value" }
  if (isMegapotNotTicketOwner(error)) return { disposition: "needs_review" }
  return { disposition: "retry_later" }
}
