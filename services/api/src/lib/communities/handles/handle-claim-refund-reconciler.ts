import type { Env } from "../../../env"
import { badRequestError } from "../../errors"
import type { Client, QueryResultRow } from "../../sql-client"
import { requiredString, rowValue } from "../../sql-row"
import { getControlPlaneClient, withBackgroundControlPlaneClients } from "../../runtime-deps"
import {
  assertPirateCheckoutRefundReadiness,
} from "../commerce/checkout-config"
import {
  classifyBookingPaymentReceipt,
  type BookingPaymentVerification,
} from "../commerce/funding-proof-service"
import {
  operatorSigningCoordinatorName,
  type OperatorSettleRequest,
  type OperatorSettleResult,
  type OperatorSigningCoordinatorDO,
} from "../bookings/operator-signing-coordinator-do"
import { handleClaimRefundsEnabled } from "./handle-claim-intent-config"

type RefundCoordinator = {
  settle(req: OperatorSettleRequest): Promise<OperatorSettleResult>
}

let coordinatorForTests: RefundCoordinator | null = null
export function setHandleClaimRefundCoordinatorForTests(value: RefundCoordinator | null): void {
  coordinatorForTests = value
}

function coordinator(env: Env, operatorAddress: string, chainId: number): RefundCoordinator {
  if (coordinatorForTests) return coordinatorForTests
  const namespace = env.OPERATOR_SIGNING_COORDINATOR as DurableObjectNamespace<OperatorSigningCoordinatorDO> | undefined
  if (!namespace) throw badRequestError("OPERATOR_SIGNING_COORDINATOR binding is not configured")
  return namespace.getByName(operatorSigningCoordinatorName(operatorAddress, chainId, "checkout"))
}

function refundRequest(row: QueryResultRow): OperatorSettleRequest {
  const intentId = requiredString(row, "community_handle_claim_intent_id")
  return {
    operatorKind: "checkout",
    effectKind: "handle_claim_refund",
    fundingEffectId: intentId,
    idempotencyKey: intentId,
    amountAtomic: requiredString(row, "amount_atomic"),
    recipientAddress: requiredString(row, "sender_address"),
  }
}

async function mirrorResult(input: {
  client: Client
  intentId: string
  now: string
  result: OperatorSettleResult
}): Promise<{ confirmed: boolean; operatorAttention: boolean }> {
  const confirmed = input.result.state === "confirmed" && input.result.txHash != null
  const operatorAttention = [
    "preparation_parked",
    "reconciliation_required",
    "replaced",
    "failed_onchain",
  ].includes(input.result.state)
  const updated = await input.client.execute({
    sql: `
      UPDATE community_handle_claim_intents
      SET refund_coordinator_ref = COALESCE(refund_coordinator_ref, ?2),
          refund_coordinator_state = ?3,
          refund_tx_hash = COALESCE(refund_tx_hash, ?4),
          refund_attempt_count = refund_attempt_count + 1,
          refund_last_error = CASE WHEN ?5 THEN ?3 ELSE NULL END,
          status = CASE WHEN ?6 THEN 'refunded' ELSE status END,
          refunded_at = CASE WHEN ?6 THEN ?7 ELSE refunded_at END,
          updated_at = ?7
      WHERE community_handle_claim_intent_id = ?1
        AND status = 'refund_pending'
        AND (refund_coordinator_ref IS NULL OR refund_coordinator_ref = ?2)
        AND (refund_tx_hash IS NULL OR refund_tx_hash = ?4)
      RETURNING status
    `,
    args: [
      input.intentId,
      input.result.idempotencyKey,
      input.result.state,
      input.result.txHash,
      operatorAttention,
      confirmed,
      input.now,
    ],
  })
  return {
    confirmed: updated.rows[0] != null && String(rowValue(updated.rows[0], "status")) === "refunded",
    operatorAttention,
  }
}

export type HandleClaimRefundSummary = {
  enabled: boolean
  queued: number
  scanned: number
  enqueued: number
  confirmed: number
  pending_finality: number
  rejected_finality: number
  custody_mismatch: number
  operator_attention: number
  errors: number
}

export async function reconcileHandleClaimRefunds(input: {
  env: Env
  limit?: number
  now?: string
  verify?: (expected: {
    chainId: number
    tokenAddress: string
    recipientAddress: string
    amountAtomic: bigint
    senderAddress: string
  }, txHash: string, rpcUrl: string) => Promise<BookingPaymentVerification>
}): Promise<HandleClaimRefundSummary> {
  const queuedResult = await withBackgroundControlPlaneClients(async () => await getControlPlaneClient(input.env).execute(
    "SELECT COUNT(*) AS queued FROM community_handle_claim_intents WHERE status = 'refund_pending'",
  ))
  const queued = Number(rowValue(queuedResult.rows[0] ?? {}, "queued") ?? 0)
  const enabled = handleClaimRefundsEnabled(input.env)
  const summary: HandleClaimRefundSummary = {
    enabled,
    queued,
    scanned: 0,
    enqueued: 0,
    confirmed: 0,
    pending_finality: 0,
    rejected_finality: 0,
    custody_mismatch: 0,
    operator_attention: 0,
    errors: 0,
  }
  if (!enabled || queued === 0) return summary

  const readiness = assertPirateCheckoutRefundReadiness(input.env)
  const now = input.now ?? new Date().toISOString()
  const rows = await withBackgroundControlPlaneClients(async () => (
    await getControlPlaneClient(input.env).execute({
      sql: `
        SELECT i.community_handle_claim_intent_id, i.chain_id, i.token_address,
          i.funding_destination_address, i.custody_account_id, i.custody_key_epoch,
          i.funding_tx_hash, i.refund_coordinator_ref, i.refund_tx_hash,
          CAST(r.amount_atomic AS TEXT) AS amount_atomic,
          r.sender_address, r.recipient_address, r.match_status
        FROM community_handle_claim_intents i
        JOIN observed_funding_receipts r
          ON r.observed_funding_receipt_id = i.observed_funding_receipt_id
        WHERE i.status = 'refund_pending'
        ORDER BY i.updated_at ASC, i.community_handle_claim_intent_id ASC
        LIMIT ?1
      `,
      args: [Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)))],
    })
  ).rows)

  for (const row of rows) {
    summary.scanned += 1
    const intentId = requiredString(row, "community_handle_claim_intent_id")
    try {
      if (String(rowValue(row, "match_status") ?? "") === "refund_review") {
        summary.operator_attention += 1
        continue
      }
      const expected = {
        chainId: Number(rowValue(row, "chain_id")),
        tokenAddress: requiredString(row, "token_address"),
        recipientAddress: requiredString(row, "funding_destination_address"),
        amountAtomic: BigInt(requiredString(row, "amount_atomic")),
        senderAddress: requiredString(row, "sender_address"),
      }
      if (
        expected.chainId !== readiness.chainId
        || expected.tokenAddress.toLowerCase() !== readiness.tokenAddress.toLowerCase()
        || expected.recipientAddress.toLowerCase() !== readiness.operatorAddress.toLowerCase()
        || requiredString(row, "recipient_address").toLowerCase() !== readiness.operatorAddress.toLowerCase()
        || requiredString(row, "custody_account_id") !== readiness.custodyAccountId
        || requiredString(row, "custody_key_epoch") !== readiness.custodyKeyEpoch
      ) {
        throw new Error("Handle refund custody snapshot does not match the active signer epoch")
      }
      const verification = input.verify
        ? await input.verify(expected, requiredString(row, "funding_tx_hash"), readiness.rpcUrl)
        : await classifyBookingPaymentReceipt({
            env: input.env,
            fundingTxRef: requiredString(row, "funding_tx_hash"),
            expected,
            rpcUrl: readiness.rpcUrl,
            finality: { expectedChainId: readiness.chainId, fallbackConfirmations: 30, preferSafeBlock: true },
          })
      if (verification.kind === "pending") {
        summary.pending_finality += 1
        continue
      }
      if (verification.kind === "rejected" || verification.kind === "custody_incident") {
        summary.rejected_finality += 1
        continue
      }
      if (verification.kind === "custody_mismatch") {
        summary.custody_mismatch += 1
        continue
      }
      const result = await coordinator(input.env, readiness.operatorAddress, readiness.chainId)
        .settle(refundRequest(row))
      summary.enqueued += 1
      const mirrored = await withBackgroundControlPlaneClients(async () => await mirrorResult({
        client: getControlPlaneClient(input.env),
        intentId,
        result,
        now,
      }))
      if (mirrored.confirmed) summary.confirmed += 1
      if (mirrored.operatorAttention) summary.operator_attention += 1
    } catch (error) {
      summary.errors += 1
      await withBackgroundControlPlaneClients(async () => {
        await getControlPlaneClient(input.env).execute({
          sql: `
            UPDATE community_handle_claim_intents
            SET refund_attempt_count = refund_attempt_count + 1,
                refund_last_error = ?2, updated_at = ?3
            WHERE community_handle_claim_intent_id = ?1 AND status = 'refund_pending'
          `,
          args: [intentId, (error instanceof Error ? error.message : String(error)).slice(0, 1000), now],
        })
      })
    }
  }
  return summary
}
