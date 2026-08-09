import type { Env } from "../../env"
import {
  operatorSigningCoordinatorName,
  type OperatorSettleResult,
  type OperatorSigningCoordinatorDO,
} from "../communities/bookings/operator-signing-coordinator-do"
import {
  resolveRewardsSettlementChainId,
  resolveRewardsSettlementOperatorAddress,
} from "../communities/bookings/booking-chain-config"
import { badRequestError, conflictError, notFoundError } from "../errors"
import type { Client } from "../sql-client"
import { rowValue, stringOrNull } from "../sql-row"

export type RewardSettlementManualResolutionInput = {
  env: Env
  client: Client
  effectKind: "cashout" | "funding_refund"
  effectId: string
  expectedTxHash: string
  expectedNonce?: number
  resolution: "confirmed" | "failed_onchain" | "failed_prebroadcast" | "failed_nonce_invalidated"
  reason: string
  operatorActorId: string
}

type ManualResolutionCoordinator = Pick<
  OperatorSigningCoordinatorDO,
  "resolveRewardReconciliation" | "resolveRewardNoBroadcast" | "resolveRewardInvalidatedBroadcast"
>

let coordinatorForTests: ManualResolutionCoordinator | null = null

export function setRewardSettlementManualResolutionCoordinatorForTests(
  coordinator: ManualResolutionCoordinator | null,
): void {
  coordinatorForTests = coordinator
}

function coordinator(env: Env): ManualResolutionCoordinator {
  if (coordinatorForTests) return coordinatorForTests
  const ns = env.OPERATOR_SIGNING_COORDINATOR as DurableObjectNamespace<OperatorSigningCoordinatorDO> | undefined
  if (!ns) throw badRequestError("OPERATOR_SIGNING_COORDINATOR binding is not configured")
  return ns.getByName(operatorSigningCoordinatorName(
    resolveRewardsSettlementOperatorAddress(env),
    resolveRewardsSettlementChainId(env),
    "rewards",
  ))
}

export async function resolveRewardSettlementManually(
  input: RewardSettlementManualResolutionInput,
): Promise<OperatorSettleResult> {
  const effectId = String(input.effectId ?? "").trim()
  if (!effectId) throw badRequestError("Rewards settlement effect ID is required")
  const query = input.effectKind === "cashout"
    ? {
        sql: `
          SELECT coordinator_ref, coordinator_state, settlement_ref AS tx_hash, broadcast_nonce
          FROM reward_payout_effects
          WHERE reward_payout_effect_id = ?1
          LIMIT 1
        `,
        args: [effectId],
      }
    : {
        sql: `
          SELECT refund_coordinator_ref AS coordinator_ref,
                 refund_coordinator_state AS coordinator_state,
                 refund_tx_hash AS tx_hash
          FROM reward_campaign_funding_effects
          WHERE reward_campaign_funding_effect_id = ?1
          LIMIT 1
        `,
        args: [effectId],
      }
  const row = (await input.client.execute(query)).rows[0]
  if (!row) throw notFoundError("Rewards settlement effect not found")
  const idempotencyKey = stringOrNull(rowValue(row, "coordinator_ref"))
  const mirroredTxHash = stringOrNull(rowValue(row, "tx_hash"))
  if (!idempotencyKey || !mirroredTxHash) {
    throw conflictError("Rewards settlement mirror is missing coordinator evidence")
  }
  if (mirroredTxHash.toLowerCase() !== input.expectedTxHash.trim().toLowerCase()) {
    throw conflictError("Rewards settlement manual resolution transaction hash mismatch")
  }
  if (input.resolution === "failed_prebroadcast" || input.resolution === "failed_nonce_invalidated") {
    if (input.effectKind !== "cashout") {
      throw conflictError("Pre-broadcast recovery currently supports cashouts only")
    }
    const expectedCoordinatorState = input.resolution === "failed_prebroadcast"
      ? "prepared"
      : "preparation_parked"
    if (stringOrNull(rowValue(row, "coordinator_state")) !== expectedCoordinatorState) {
      throw conflictError("Rewards settlement mirror is not awaiting the requested broadcast recovery")
    }
    const mirroredNonce = Number(rowValue(row, "broadcast_nonce"))
    if (!Number.isSafeInteger(input.expectedNonce) || input.expectedNonce !== mirroredNonce) {
      throw conflictError("Rewards pre-broadcast recovery nonce mismatch")
    }
    const resolutionInput = {
      idempotencyKey,
      expectedTxHash: input.expectedTxHash,
      expectedNonce: input.expectedNonce,
      reason: input.reason,
      operatorActorId: input.operatorActorId,
    }
    const resolved = input.resolution === "failed_prebroadcast"
      ? await coordinator(input.env).resolveRewardNoBroadcast(resolutionInput)
      : await coordinator(input.env).resolveRewardInvalidatedBroadcast(resolutionInput)
    if (resolved.state !== "preparation_parked") {
      throw conflictError("Rewards coordinator did not terminalize pre-broadcast effect")
    }
    const tx = await input.client.transaction("write")
    try {
      const updated = await tx.execute({
        sql: `
          UPDATE reward_payout_effects
          SET status = 'failed', coordinator_state = 'preparation_parked',
              failure_reason = ?5, failed_at = ?2, updated_at = ?2
          WHERE reward_payout_effect_id = ?1 AND status = 'submitted'
            AND coordinator_state = ?6 AND settlement_ref = ?3
            AND broadcast_nonce = ?4
          RETURNING reward_payout_effect_id
        `,
        args: [
          effectId,
          new Date().toISOString(),
          input.expectedTxHash,
          input.expectedNonce,
          input.resolution,
          expectedCoordinatorState,
        ],
      })
      if (!updated.rows[0]) throw conflictError("Rewards payout changed during pre-broadcast recovery")
      await tx.execute({
        sql: `
          UPDATE reward_payout_allocations
          SET status = 'released', released_at = ?2, updated_at = ?2
          WHERE reward_payout_effect_id = ?1 AND status = 'submitted'
        `,
        args: [effectId, new Date().toISOString()],
      })
      await tx.commit()
    } catch (error) {
      await tx.rollback().catch(() => undefined)
      throw error
    } finally {
      tx.close()
    }
    return resolved
  }
  if (stringOrNull(rowValue(row, "coordinator_state")) !== "reconciliation_required") {
    throw conflictError("Rewards settlement mirror is not awaiting manual reconciliation")
  }
  return coordinator(input.env).resolveRewardReconciliation({
    idempotencyKey,
    expectedTxHash: input.expectedTxHash,
    resolution: input.resolution,
    reason: input.reason,
    operatorActorId: input.operatorActorId,
  })
}
