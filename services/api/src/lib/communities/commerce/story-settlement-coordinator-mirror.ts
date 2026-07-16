import type { Hex } from "viem"

import type { DbExecutor } from "../../db-helpers"
import { conflictError } from "../../errors"
import type {
  StorySettlementPlanResult,
  StorySettlementStepResult,
} from "../../story/story-settlement-wallet-coordinator-do"
import type { StorySettlementStepKind } from "../../story/story-settlement-call-identity"
import type { PurchaseSettlementEffectRow } from "./settlement-effects"

export type StorySettlementEffectPlanBinding = {
  effect: PurchaseSettlementEffectRow
  steps: readonly { callIdentity: Hex; stepKind: StorySettlementStepKind }[]
}

export async function claimStorySettlementCoordinatorPlan(input: {
  client: DbExecutor
  planRef: Hex
  effects: readonly PurchaseSettlementEffectRow[]
  now: string
}): Promise<void> {
  for (const effect of input.effects) {
    if (effect.coordinator_plan_ref && effect.coordinator_plan_ref !== input.planRef) {
      throw conflictError("Purchase settlement effect belongs to a different coordinator plan")
    }
    await input.client.execute({
      sql: `
        UPDATE purchase_settlement_effects
        SET coordinator_plan_ref = ?2,
            coordinator_state = COALESCE(coordinator_state, 'pending'),
            coordinator_version = COALESCE(coordinator_version, 0),
            updated_at = ?3
        WHERE purchase_settlement_effect_id = ?1
          AND (coordinator_plan_ref IS NULL OR coordinator_plan_ref = ?2)
      `,
      args: [effect.purchase_settlement_effect_id, input.planRef, input.now],
    })
  }
}

function effectState(steps: readonly StorySettlementStepResult[]): "submitted" | "confirmed" | "failed" {
  if (steps.every((step) => step.state === "confirmed")) return "confirmed"
  if (steps.some((step) => step.state === "reverted" || step.state === "replaced")) return "failed"
  return "submitted"
}

function effectSettlementRef(steps: readonly StorySettlementStepResult[]): string | null {
  const terminalCall = [...steps].reverse().find((step) => step.transactionHash)
  return terminalCall?.transactionHash ?? null
}

export async function mirrorStorySettlementCoordinatorPlan(input: {
  client: DbExecutor
  chainId: number
  signerAddress: string
  plan: StorySettlementPlanResult
  bindings: readonly StorySettlementEffectPlanBinding[]
  now: string
}): Promise<void> {
  for (const binding of input.bindings) {
    const callIdentities = binding.steps.map((step) => step.callIdentity)
    const steps = input.plan.steps.filter((step) => callIdentities.includes(step.callIdentity))
    if (steps.length !== callIdentities.length) {
      throw conflictError("Story settlement coordinator plan is missing an effect step")
    }
    const currentVersion = binding.effect.coordinator_version ?? 0
    if (binding.effect.coordinator_plan_ref !== input.plan.planRef || currentVersion > input.plan.version) {
      throw conflictError("Stale or mismatched Story settlement coordinator mirror")
    }

    const status = effectState(steps)
    const settlementRef = effectSettlementRef(steps)
    await input.client.execute({
      sql: `
        UPDATE purchase_settlement_effects
        SET status = ?2,
            coordinator_state = ?3,
            coordinator_version = ?4,
            settlement_ref = CASE WHEN ?2 = 'confirmed' THEN ?5 ELSE settlement_ref END,
            provider_receipt_ref = CASE WHEN ?2 = 'confirmed' THEN ?5 ELSE provider_receipt_ref END,
            broadcast_tx_ref = COALESCE(broadcast_tx_ref, ?5),
            failure_disposition = CASE WHEN ?2 = 'failed' THEN 'reconciliation_required' ELSE NULL END,
            failure_reason = CASE WHEN ?2 = 'failed' THEN 'coordinator_plan_failed' ELSE NULL END,
            reconciliation_reason = CASE WHEN ?2 = 'failed' THEN 'coordinator_terminal_step' ELSE NULL END,
            last_reconciled_at = ?6,
            confirmed_at = CASE WHEN ?2 = 'confirmed' THEN COALESCE(confirmed_at, ?6) ELSE confirmed_at END,
            finality_confirmed_at = CASE WHEN ?2 = 'confirmed' THEN COALESCE(finality_confirmed_at, ?6) ELSE finality_confirmed_at END,
            failed_at = CASE WHEN ?2 = 'failed' THEN COALESCE(failed_at, ?6) ELSE NULL END,
            updated_at = ?6
        WHERE purchase_settlement_effect_id = ?1
          AND coordinator_plan_ref = ?7
          AND COALESCE(coordinator_version, 0) <= ?4
      `,
      args: [
        binding.effect.purchase_settlement_effect_id,
        status,
        input.plan.state,
        input.plan.version,
        settlementRef,
        input.now,
        input.plan.planRef,
      ],
    })

    // Re-read the fence after the effect write. Same-version replay repairs a crash
    // between the effect update and these transaction upserts; an older observation
    // can never overwrite transaction evidence after a newer plan version wins.
    const versionRow = await input.client.execute({
      sql: `SELECT coordinator_version FROM purchase_settlement_effects WHERE purchase_settlement_effect_id = ?1 LIMIT 1`,
      args: [binding.effect.purchase_settlement_effect_id],
    })
    if (Number(versionRow.rows[0]?.coordinator_version) !== input.plan.version) continue

    for (const step of steps) {
      await upsertMirroredStep({
        client: input.client,
        effectId: binding.effect.purchase_settlement_effect_id,
        chainId: input.chainId,
        signerAddress: input.signerAddress,
        step,
        stepKind: binding.steps.find((candidate) => candidate.callIdentity === step.callIdentity)!.stepKind,
        now: input.now,
      })
    }
  }
}

async function upsertMirroredStep(input: {
  client: DbExecutor
  effectId: string
  chainId: number
  signerAddress: string
  step: StorySettlementStepResult
  stepKind: StorySettlementStepKind
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO purchase_settlement_transactions (
        purchase_settlement_transaction_id, purchase_settlement_effect_id, step_key, step_kind,
        ordinal, call_identity_hash, coordinator_step_ref, state, chain_id, signer_address,
        nonce, tx_hash, block_number, block_hash, attempt_count, last_error_code,
        prepared_at, broadcast_at, mined_at, confirmed_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
        ?10, ?11, ?12, ?13, ?14, ?15,
        CASE WHEN ?7 IN ('prepared','broadcast','mined','confirmed','reverted','reconciliation_required') THEN ?16 ELSE NULL END,
        CASE WHEN ?7 IN ('broadcast','mined','confirmed','reverted','reconciliation_required') THEN ?16 ELSE NULL END,
        CASE WHEN ?7 IN ('mined','confirmed','reverted') THEN ?16 ELSE NULL END,
        CASE WHEN ?7 = 'confirmed' THEN ?16 ELSE NULL END,
        ?16
      )
      ON CONFLICT(coordinator_step_ref) DO UPDATE SET
        state = excluded.state,
        nonce = COALESCE(excluded.nonce, purchase_settlement_transactions.nonce),
        tx_hash = COALESCE(excluded.tx_hash, purchase_settlement_transactions.tx_hash),
        block_number = excluded.block_number,
        block_hash = excluded.block_hash,
        attempt_count = excluded.attempt_count,
        last_error_code = excluded.last_error_code,
        prepared_at = COALESCE(purchase_settlement_transactions.prepared_at, excluded.prepared_at),
        broadcast_at = COALESCE(purchase_settlement_transactions.broadcast_at, excluded.broadcast_at),
        mined_at = COALESCE(purchase_settlement_transactions.mined_at, excluded.mined_at),
        confirmed_at = COALESCE(purchase_settlement_transactions.confirmed_at, excluded.confirmed_at),
        updated_at = excluded.updated_at
    `,
    args: [
      `pst_${input.step.stepRef.slice(2)}`,
      input.effectId,
      input.stepKind,
      input.step.ordinal,
      input.step.callIdentity,
      input.step.stepRef,
      input.step.state,
      input.chainId,
      input.signerAddress,
      input.step.nonce,
      input.step.transactionHash,
      input.step.receipt?.blockNumber.toString() ?? null,
      input.step.receipt?.blockHash ?? null,
      input.step.attemptCount,
      input.step.lastErrorCode,
      input.now,
    ],
  })
}
