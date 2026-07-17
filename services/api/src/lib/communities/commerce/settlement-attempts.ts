import { conflictError } from "../../errors"

export type PurchaseSettlementAttemptRow = {
  attempt_id: string
  quote_id: string
  purchase_id: string
  community_id: string
  settlement_wallet_attachment_id: string
  settlement_tx_ref: string | null
  status: "attempting" | "finalized" | "failed"
  failure_reason: string | null
  attempt_count: number
  created_at: string
  updated_at: string
}

export type SettlementExecutor = {
  execute(statement: { sql: string; args?: any[] }): Promise<{ rows: Record<string, unknown>[]; rowsAffected?: number }>
}

const SETTLEMENT_ATTEMPT_STALE_MS = 5 * 60 * 1000

function toPurchaseSettlementAttemptRow(row: Record<string, unknown>): PurchaseSettlementAttemptRow {
  return {
    attempt_id: String(row.attempt_id),
    quote_id: String(row.quote_id),
    purchase_id: String(row.purchase_id),
    community_id: String(row.community_id),
    settlement_wallet_attachment_id: String(row.settlement_wallet_attachment_id),
    settlement_tx_ref: row.settlement_tx_ref == null ? null : String(row.settlement_tx_ref),
    status: String(row.status) as PurchaseSettlementAttemptRow["status"],
    failure_reason: row.failure_reason == null ? null : String(row.failure_reason),
    attempt_count: Number(row.attempt_count ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

export async function getPurchaseSettlementAttempt(input: {
  client: SettlementExecutor
  quoteId: string
}): Promise<PurchaseSettlementAttemptRow | null> {
  const result = await input.client.execute({
    sql: `
      SELECT attempt_id, quote_id, purchase_id, community_id, status, failure_reason, created_at, updated_at
             , settlement_wallet_attachment_id, settlement_tx_ref, attempt_count
      FROM purchase_settlement_attempts
      WHERE quote_id = ?1
      LIMIT 1
    `,
    args: [input.quoteId],
  })
  const row = result.rows[0]
  return row ? toPurchaseSettlementAttemptRow(row) : null
}

export async function reservePurchaseSettlementAttempt(input: {
  client: SettlementExecutor
  communityId: string
  quoteId: string
  purchaseId: string
  settlementWalletAttachmentId: string
  settlementTxRef: string | null
  coordinatorOwned: boolean
  now: string
}): Promise<"reserved" | "finalized"> {
  const attemptId = `psa_${input.purchaseId.replace(/^pur_/, "")}`
  const insertResult = await input.client.execute({
    sql: `
      INSERT INTO purchase_settlement_attempts (
        attempt_id, quote_id, purchase_id, community_id, settlement_wallet_attachment_id,
        settlement_tx_ref, status, failure_reason, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, 'attempting', NULL, ?7, ?7
      )
      ON CONFLICT(quote_id) DO NOTHING
    `,
    args: [
      attemptId,
      input.quoteId,
      input.purchaseId,
      input.communityId,
      input.settlementWalletAttachmentId,
      input.settlementTxRef,
      input.now,
    ],
  })
  if ((insertResult.rowsAffected ?? 0) > 0) {
    return "reserved"
  }

  const attempt = await getPurchaseSettlementAttempt({
    client: input.client,
    quoteId: input.quoteId,
  })
  if (!attempt) {
    throw conflictError("Purchase settlement reservation could not be verified")
  }
  if (attempt.status === "finalized") {
    return "finalized"
  }
  if (attempt.status === "failed") {
    await input.client.execute({
      sql: `
        UPDATE purchase_settlement_attempts
        SET status = 'attempting',
            failure_reason = NULL,
            attempt_count = attempt_count + 1,
            updated_at = ?2
        WHERE quote_id = ?1
          AND status = 'failed'
      `,
      args: [input.quoteId, input.now],
    })
    return "reserved"
  }

  // The wallet coordinator owns broadcast exclusivity for a plan-ref'd purchase.
  // Re-entry is how polling and cron reconciliation drive its durable journal; the
  // legacy attempt lease must not fence that read/reconcile path.
  if (input.coordinatorOwned) {
    return "reserved"
  }

  const updatedAtMs = Date.parse(attempt.updated_at)
  if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= SETTLEMENT_ATTEMPT_STALE_MS) {
    const reclaimResult = await input.client.execute({
      sql: `
        UPDATE purchase_settlement_attempts
        SET attempt_count = attempt_count + 1,
            updated_at = ?2
        WHERE quote_id = ?1
          AND status = 'attempting'
          AND updated_at = ?3
      `,
      args: [input.quoteId, input.now, attempt.updated_at],
    })
    if ((reclaimResult.rowsAffected ?? 0) === 0) {
      throw conflictError("Purchase settlement is already in progress")
    }
    return "reserved"
  }

  throw conflictError("Purchase settlement is already in progress")
}

export async function listStalePurchaseSettlementAttempts(input: {
  client: SettlementExecutor
  staleBefore: string
  limit: number
}): Promise<PurchaseSettlementAttemptRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT attempt_id, quote_id, purchase_id, community_id, status, failure_reason, created_at, updated_at
             , settlement_wallet_attachment_id, settlement_tx_ref, attempt_count
      FROM purchase_settlement_attempts
      WHERE status = 'attempting'
        AND updated_at < ?1
      ORDER BY updated_at ASC
      LIMIT ?2
    `,
    args: [input.staleBefore, input.limit],
  })
  return result.rows.map((row) => toPurchaseSettlementAttemptRow(row))
}

export async function markPurchaseSettlementAttemptFailed(input: {
  client: SettlementExecutor
  quoteId: string
  failureReason: string
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE purchase_settlement_attempts
      SET status = 'failed',
          failure_reason = ?2,
          attempt_count = attempt_count + 1,
          updated_at = ?3
      WHERE quote_id = ?1
        AND status = 'attempting'
    `,
    args: [input.quoteId, input.failureReason, input.now],
  })
}
