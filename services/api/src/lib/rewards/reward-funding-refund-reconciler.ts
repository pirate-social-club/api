import type { Env } from "../../env"
import { badRequestError } from "../errors"
import { requiredString, rowValue } from "../sql-row"
import type { Client, QueryResultRow } from "../sql-client"
import { classifyBookingPaymentReceipt, type BookingPaymentVerification } from "../communities/commerce/funding-proof-service"
import {
  operatorSigningCoordinatorName,
  type OperatorSettleRequest,
  type OperatorSettleResult,
  type OperatorSigningCoordinatorDO,
} from "../communities/bookings/operator-signing-coordinator-do"
import {
  assertRewardsCampaignTreasuryMatchesSettlementOperator,
  resolveRewardsSettlementChainId,
  resolveRewardsSettlementOperatorAddress,
} from "../communities/bookings/booking-chain-config"
import { resolveRewardCampaignConfig } from "./reward-campaign-config"

type RefundCoordinator = {
  settle(req: OperatorSettleRequest): Promise<OperatorSettleResult>
}

let coordinatorForTests: RefundCoordinator | null = null
export function setRewardFundingRefundCoordinatorForTests(value: RefundCoordinator | null): void {
  coordinatorForTests = value
}

function literalTrue(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true"
}

function coordinator(env: Env): RefundCoordinator {
  if (coordinatorForTests) return coordinatorForTests
  const ns = env.OPERATOR_SIGNING_COORDINATOR as DurableObjectNamespace<OperatorSigningCoordinatorDO> | undefined
  if (!ns) throw badRequestError("OPERATOR_SIGNING_COORDINATOR binding is not configured")
  return ns.getByName(operatorSigningCoordinatorName(
    resolveRewardsSettlementOperatorAddress(env),
    resolveRewardsSettlementChainId(env),
    "rewards",
  ))
}

function refundRequest(row: QueryResultRow): OperatorSettleRequest {
  const fundingEffectId = requiredString(row, "reward_campaign_funding_effect_id")
  return {
    operatorKind: "rewards",
    effectKind: "reward_funding_refund",
    fundingEffectId,
    idempotencyKey: fundingEffectId,
    amountAtomic: requiredString(row, "received_amount_atomic"),
    recipientAddress: requiredString(row, "sender_address"),
  }
}

async function mirrorResult(input: {
  client: Client
  row: QueryResultRow
  result: OperatorSettleResult
  now: string
}): Promise<boolean> {
  const fundingEffectId = requiredString(input.row, "reward_campaign_funding_effect_id")
  const confirmed = input.result.state === "confirmed" && input.result.txHash != null
  const terminalError = input.result.state === "replaced" || input.result.state === "failed_onchain"
  const updated = await input.client.execute({
    sql: `
      UPDATE reward_campaign_funding_effects
      SET refund_coordinator_ref = COALESCE(refund_coordinator_ref, ?2),
          refund_coordinator_state = ?3,
          refund_tx_hash = COALESCE(refund_tx_hash, ?4),
          refund_attempt_count = refund_attempt_count + 1,
          refund_last_error = CASE WHEN ?5 THEN ?3 ELSE NULL END,
          status = CASE WHEN ?6 THEN 'refunded' ELSE status END,
          refunded_at = CASE WHEN ?6 THEN ?7 ELSE refunded_at END,
          refund_confirmed_at = CASE WHEN ?6 THEN ?7 ELSE refund_confirmed_at END,
          updated_at = ?7
      WHERE reward_campaign_funding_effect_id = ?1
        AND status = 'refund_pending'
        AND (refund_coordinator_ref IS NULL OR refund_coordinator_ref = ?2)
        AND (refund_tx_hash IS NULL OR refund_tx_hash = ?4)
      RETURNING status
    `,
    args: [
      fundingEffectId,
      input.result.idempotencyKey,
      input.result.state,
      input.result.txHash,
      terminalError,
      confirmed,
      input.now,
    ],
  })
  const row = updated.rows[0]
  return row != null && String(rowValue(row, "status")) === "refunded"
}

export type RewardFundingRefundSummary = {
  enabled: boolean
  scanned: number
  enqueued: number
  confirmed: number
  pending_finality: number
  rejected_finality: number
  errors: number
}

export async function reconcileRewardFundingRefunds(input: {
  env: Env
  client: Client
  limit?: number
  now?: string
  verify?: (expected: {
    chainId: number
    tokenAddress: string
    recipientAddress: string
    amountAtomic: bigint
    senderAddress: string
  }, txHash: string, rpcUrl: string) => Promise<BookingPaymentVerification>
}): Promise<RewardFundingRefundSummary> {
  const campaigns = resolveRewardCampaignConfig(input.env)
  const enabled = campaigns.enabled && literalTrue(input.env.REWARDS_PAYOUTS_ENABLED)
  const summary: RewardFundingRefundSummary = {
    enabled, scanned: 0, enqueued: 0, confirmed: 0,
    pending_finality: 0, rejected_finality: 0, errors: 0,
  }
  if (!enabled) return summary
  assertRewardsCampaignTreasuryMatchesSettlementOperator(input.env)
  const now = input.now ?? new Date().toISOString()
  const rows = (await input.client.execute({
    sql: `
      SELECT reward_campaign_funding_effect_id, chain_id, token_address,
        received_amount_atomic, sender_address, treasury_address, tx_hash,
        refund_coordinator_ref, refund_coordinator_state, refund_tx_hash
      FROM reward_campaign_funding_effects
      WHERE status = 'refund_pending'
      ORDER BY updated_at ASC, reward_campaign_funding_effect_id ASC
      LIMIT ?1
    `,
    args: [Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)))],
  })).rows
  for (const row of rows) {
    summary.scanned += 1
    try {
      const receivedAmountAtomic = requiredString(row, "received_amount_atomic")
      const txHash = requiredString(row, "tx_hash")
      const expected = {
        chainId: Number(rowValue(row, "chain_id")),
        tokenAddress: requiredString(row, "token_address"),
        recipientAddress: requiredString(row, "treasury_address"),
        amountAtomic: BigInt(receivedAmountAtomic),
        senderAddress: requiredString(row, "sender_address"),
      }
      if (
        expected.chainId !== campaigns.chainId
        || expected.tokenAddress.toLowerCase() !== campaigns.tokenAddress.toLowerCase()
        || expected.recipientAddress.toLowerCase() !== campaigns.treasuryAddress.toLowerCase()
      ) {
        summary.rejected_finality += 1
        continue
      }
      const verification = input.verify
        ? await input.verify(expected, txHash, campaigns.rpcUrl)
        : await classifyBookingPaymentReceipt({
            env: input.env,
            fundingTxRef: txHash,
            expected,
            rpcUrl: campaigns.rpcUrl,
            finality: { expectedChainId: campaigns.chainId, fallbackConfirmations: 30, preferSafeBlock: true },
          })
      if (verification.kind === "pending") {
        summary.pending_finality += 1
        continue
      }
      if (verification.kind === "rejected") {
        summary.rejected_finality += 1
        continue
      }
      const observed = verification.kind === "custody_mismatch"
        ? verification.observedAmountAtomic
        : receivedAmountAtomic
      if (observed !== receivedAmountAtomic) {
        summary.rejected_finality += 1
        continue
      }
      const result = await coordinator(input.env).settle(refundRequest(row))
      summary.enqueued += 1
      if (await mirrorResult({ client: input.client, row, result, now })) summary.confirmed += 1
    } catch (error) {
      summary.errors += 1
      await input.client.execute({
        sql: `
          UPDATE reward_campaign_funding_effects
          SET refund_attempt_count = refund_attempt_count + 1,
              refund_last_error = ?2,
              updated_at = ?3
          WHERE reward_campaign_funding_effect_id = ?1 AND status = 'refund_pending'
        `,
        args: [
          requiredString(row, "reward_campaign_funding_effect_id"),
          (error instanceof Error ? error.message : String(error)).slice(0, 1000),
          now,
        ],
      })
    }
  }
  return summary
}
