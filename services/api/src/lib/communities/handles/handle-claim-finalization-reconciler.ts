import type { Env } from "../../../env"
import { HttpError } from "../../errors"
import { getControlPlaneClient, withBackgroundControlPlaneClients } from "../../runtime-deps"
import {
  decodeFundedHandleClaimFinalization,
  type FundedHandleClaimFinalization,
} from "./handle-claim-intent-finalizer"
import { completeFundedHandleClaimIntent } from "./handle-claim-intent-ledger"
import { releaseExpiredHandleClaimTokenAllocations } from "./handle-claim-intent-ledger"

export type HandleClaimFinalizationResult =
  | { kind: "completed"; handleId: string }
  | { kind: "retryable"; reason: string }
  | { kind: "terminal"; reason: string }

export type HandleClaimFinalizationSummary = {
  scanned: number
  completed: number
  retryable: number
  refund_pending: number
  errors: number
}

export function classifyHandleClaimFinalizationError(error: unknown): HandleClaimFinalizationResult {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
  if (error instanceof HttpError && !error.retryable && error.status >= 400 && error.status < 500) {
    return { kind: "terminal", reason }
  }
  const normalized = reason.toLowerCase()
  if (normalized.includes("unique constraint") || normalized.includes("constraint failed")) {
    return { kind: "terminal", reason }
  }
  return { kind: "retryable", reason }
}

export async function reconcileFundedHandleClaimIntents(input: {
  env: Env
  finalize: (candidate: FundedHandleClaimFinalization) => Promise<HandleClaimFinalizationResult>
  limit?: number
  now?: string
}): Promise<HandleClaimFinalizationSummary> {
  const now = input.now ?? new Date().toISOString()
  const candidates = await withBackgroundControlPlaneClients(async () => {
    const client = getControlPlaneClient(input.env)
    await releaseExpiredHandleClaimTokenAllocations({ client, now })
    const rows = (await client.execute({
      sql: `
        SELECT community_handle_claim_intent_id, community_id, actor_user_id,
          namespace_id, namespace_normalized_label, label_normalized, label_display,
          price_cents, pricing_model, pricing_tier, settlement_wallet_attachment_id,
          protocol_owner_wallet_attachment_id, protocol_owner_script_pubkey_hex,
          protocol_issuance_required, latest_quote_id, funding_tx_hash
        FROM community_handle_claim_intents
        WHERE status = 'funded_pending_finalization'
          AND (finalization_next_attempt_at IS NULL OR finalization_next_attempt_at <= ?1)
        ORDER BY updated_at ASC, community_handle_claim_intent_id ASC
        LIMIT ?2
      `,
      args: [now, Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)))],
    })).rows
    return rows.map(decodeFundedHandleClaimFinalization)
  })

  const summary: HandleClaimFinalizationSummary = {
    scanned: candidates.length,
    completed: 0,
    retryable: 0,
    refund_pending: 0,
    errors: 0,
  }
  for (const candidate of candidates) {
    let result: HandleClaimFinalizationResult
    try {
      // Deliberately outside every control-plane client scope. A shard RPC must
      // never pin a Hyperdrive/Postgres connection or transaction.
      result = await input.finalize(candidate)
    } catch (error) {
      result = { kind: "retryable", reason: error instanceof Error ? error.message : String(error) }
      summary.errors += 1
    }
    await withBackgroundControlPlaneClients(async () => {
      const client = getControlPlaneClient(input.env)
      if (result.kind === "completed") {
        await completeFundedHandleClaimIntent({
          client,
          intentId: candidate.intentId,
          now,
        })
        summary.completed += 1
        return
      }
      if (result.kind === "terminal") {
        await client.execute({
          sql: `
            UPDATE community_handle_claim_intents
            SET status = 'refund_pending', refund_pending_at = ?2, refund_reason = ?3,
                finalization_attempt_count = finalization_attempt_count + 1,
                finalization_last_error = ?3, finalization_next_attempt_at = NULL,
                updated_at = ?2
            WHERE community_handle_claim_intent_id = ?1
              AND status = 'funded_pending_finalization'
          `,
          args: [candidate.intentId, now, result.reason.slice(0, 1000)],
        })
        summary.refund_pending += 1
        return
      }
      const nextAttemptAt = new Date(Date.parse(now) + 30_000).toISOString()
      await client.execute({
        sql: `
          UPDATE community_handle_claim_intents
          SET finalization_attempt_count = finalization_attempt_count + 1,
              finalization_last_error = ?2, finalization_next_attempt_at = ?3,
              updated_at = ?4
          WHERE community_handle_claim_intent_id = ?1
            AND status = 'funded_pending_finalization'
        `,
        args: [candidate.intentId, result.reason.slice(0, 1000), nextAttemptAt, now],
      })
      summary.retryable += 1
    })
  }
  return summary
}
