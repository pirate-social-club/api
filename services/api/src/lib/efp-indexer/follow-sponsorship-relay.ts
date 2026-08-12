import type { Address, Hex } from "viem"

import type { Env } from "../../env"
import { badRequestError, conflictError, eligibilityFailed, rateLimited } from "../errors"
import type { Client, QueryResult, QueryResultRow, Transaction } from "../sql-client"
import { withTransaction } from "../transactions"

type PreparedTransaction = { chain_id: number; data: Hex; to: Address }
const SPONSORSHIP_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1_000

export type FollowRelayRequest = {
  authorizationSignature: string
  requestExpiry: string
  intentId: string
  transactionIndex: number
  privyWalletId: string
  walletAddress: Address
  transaction: { data: Hex; to: Address; value?: string }
}

type PrivyRelayPayload = {
  data?: {
    hash?: unknown
    transaction_id?: unknown
    user_operation_hash?: unknown
  }
  error?: unknown
  hash?: unknown
  message?: unknown
}

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function requiredConfig(env: Env) {
  const appId = env.PRIVY_APP_ID?.trim()
  const appSecret = env.PRIVY_APP_SECRET?.trim()
  const dailyLimit = positiveInteger(env.EFP_FOLLOW_SPONSOR_DAILY_TRANSACTION_LIMIT)
  const estimatedUsdMicros = positiveInteger(
    env.EFP_FOLLOW_SPONSOR_ESTIMATED_USD_MICROS_PER_TRANSACTION,
  )
  if (!appId || !appSecret || !dailyLimit || !estimatedUsdMicros) {
    throw eligibilityFailed("Follow sponsorship is unavailable")
  }
  return { appId, appSecret, dailyLimit, estimatedUsdMicros }
}

function asPreparedTransactions(value: unknown): PreparedTransaction[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  if (!Array.isArray(parsed)) throw conflictError("Prepared follow transaction is invalid")
  return parsed as PreparedTransaction[]
}

function numberValue(row: QueryResultRow, key: string): number {
  const value = Number(row[key])
  if (!Number.isSafeInteger(value) || value < 0) throw conflictError("Follow sponsorship state is invalid")
  return value
}

function exactTransaction(expected: PreparedTransaction, request: FollowRelayRequest): boolean {
  return expected.chain_id === 8453
    && request.transaction.to.toLowerCase() === expected.to.toLowerCase()
    && request.transaction.data.toLowerCase() === expected.data.toLowerCase()
    && (request.transaction.value == null || request.transaction.value === "0x0" || request.transaction.value === "0")
}

function validateRequestExpiry(value: string, now: Date): void {
  if (!/^\d{13}$/u.test(value)) throw badRequestError("Invalid Privy request expiry")
  const expiry = Number(value)
  const nowMs = now.getTime()
  if (!Number.isSafeInteger(expiry) || expiry <= nowMs || expiry > nowMs + 30 * 60 * 1_000) {
    throw badRequestError("Invalid Privy request expiry")
  }
}

function privyErrorMessage(payload: PrivyRelayPayload | null, status: number): string {
  if (typeof payload?.message === "string" && payload.message.trim()) return payload.message
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error
  if (payload?.error && typeof payload.error === "object") {
    const error = payload.error as Record<string, unknown>
    if (typeof error.message === "string" && error.message.trim()) return error.message
    if (typeof error.error === "string" && error.error.trim()) return error.error
  }
  return `Privy relay returned ${status}`
}

function transactionHash(payload: PrivyRelayPayload | null): string {
  return String(payload?.data?.hash ?? payload?.hash ?? "").toLowerCase()
}

export function privyFollowRequestId(intentId: string, transactionIndex: number): string {
  return `${intentId}-${transactionIndex}`
}

async function waitForPrivyTransactionHash(input: {
  apiUrl: string
  appId: string
  appSecret: string
  transactionId: string
  fetcher: typeof fetch
}): Promise<Hex | null> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const response = await input.fetcher(
      `${input.apiUrl}/v1/transactions/${encodeURIComponent(input.transactionId)}`,
      {
        headers: {
          authorization: `Basic ${btoa(`${input.appId}:${input.appSecret}`)}`,
          "privy-app-id": input.appId,
        },
        signal: AbortSignal.timeout(5_000),
      },
    )
    const payload = await response.json().catch(() => null) as {
      status?: unknown
      transaction_hash?: unknown
    } | null
    const hash = String(payload?.transaction_hash ?? "").toLowerCase()
    if (response.ok && /^0x[a-f0-9]{64}$/u.test(hash)) return hash as Hex
    if (
      response.ok
      && ["execution_reverted", "failed", "provider_error"].includes(String(payload?.status))
    ) {
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}

async function loadAndReserve(input: {
  tx: Transaction
  env: Env
  actorUserId: string
  request: FollowRelayRequest
  now: string
  config: ReturnType<typeof requiredConfig>
}): Promise<void> {
  const intentResult = await input.tx.execute({
    sql: `
      SELECT i.*, wa.attachment_kind, wa.source_provider
      FROM efp_follow_write_intents i
      JOIN wallet_attachments wa
        ON wa.user_id = i.actor_user_id
       AND wa.wallet_address_normalized = i.actor_wallet_address
       AND wa.status = 'active'
       AND wa.is_primary = 1
      WHERE i.follow_write_intent_id = ?1
        AND i.actor_user_id = ?2
      FOR UPDATE
    `,
    args: [input.request.intentId, input.actorUserId],
  })
  const row = intentResult.rows[0]
  if (!row) throw conflictError("Follow write intent was not found")
  if (
    row.attachment_kind !== "embedded"
    || row.source_provider !== "privy"
  ) {
    throw eligibilityFailed("This wallet is not eligible for sponsorship")
  }
  if (String(row.actor_wallet_address) !== input.request.walletAddress.toLowerCase()) {
    throw conflictError("Follow write wallet does not match the authenticated session")
  }
  const sponsoredCount = numberValue(row, "sponsored_transaction_count")
  if (
    Date.parse(String(row.expires_at)) <= Date.parse(input.now)
    && sponsoredCount === 0
  ) {
    throw conflictError("Follow write intent has expired")
  }
  if (String(row.status) !== "prepared") {
    throw conflictError("Follow write intent is not ready for this transaction")
  }
  if (input.request.transactionIndex !== sponsoredCount) {
    throw conflictError("Follow transactions must be submitted in order")
  }
  const prepared = asPreparedTransactions(row.prepared_transactions_json)
  const expected = prepared[input.request.transactionIndex]
  if (!expected || !exactTransaction(expected, input.request)) {
    throw conflictError("Relay transaction does not match the prepared follow intent")
  }

  const reservedCount = numberValue(row, "sponsorship_reserved_transaction_count")
  const previousBudgetDate = row.sponsorship_budget_date == null
    ? null
    : String(row.sponsorship_budget_date).slice(0, 10)
  const reservationNeeded = reservedCount === 0
    ? numberValue(row, "prepared_transaction_count") - sponsoredCount
    : 0
  const budgetDate = input.now.slice(0, 10)
  const reservationTransfer = reservedCount > 0 && previousBudgetDate !== budgetDate
    ? reservedCount
    : 0
  if (reservedCount > 0 && !previousBudgetDate) {
    throw conflictError("Follow sponsorship reservation has no budget date")
  }
  await input.tx.execute({
    sql: `
      INSERT INTO efp_follow_sponsorship_daily_budgets (
        budget_date, transaction_limit, estimated_usd_micros_per_transaction, updated_at
      ) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (budget_date) DO NOTHING
    `,
    args: [
      budgetDate,
      input.config.dailyLimit,
      input.config.estimatedUsdMicros,
      input.now,
    ],
  })
  const budgetResult = await input.tx.execute({
    sql: `
      SELECT transaction_limit, reserved_transactions, consumed_transactions
      FROM efp_follow_sponsorship_daily_budgets
      WHERE budget_date = ?1
      FOR UPDATE
    `,
    args: [budgetDate],
  })
  const budget = budgetResult.rows[0]
  if (!budget) throw eligibilityFailed("Follow sponsorship budget is unavailable")
  if (numberValue(budget, "transaction_limit") !== input.config.dailyLimit) {
    throw eligibilityFailed("Follow sponsorship budget configuration changed during the UTC day")
  }
  if (reservationTransfer > 0) {
    const previousBudget = await input.tx.execute({
      sql: `
        SELECT transaction_limit, reserved_transactions, consumed_transactions
        FROM efp_follow_sponsorship_daily_budgets
        WHERE budget_date = ?1
        FOR UPDATE
      `,
      args: [previousBudgetDate],
    })
    if (!previousBudget.rows[0]
      || numberValue(previousBudget.rows[0], "reserved_transactions") < reservationTransfer) {
      throw conflictError("Follow sponsorship reservation ledger is invalid")
    }
  }
  const total = numberValue(budget, "reserved_transactions") + numberValue(budget, "consumed_transactions")
  if (total + reservationNeeded + reservationTransfer > numberValue(budget, "transaction_limit")) {
    throw rateLimited("Daily follow sponsorship ceiling reached", { scope: "global_day" })
  }
  if (reservationTransfer > 0) {
    await input.tx.execute({
      sql: `
        UPDATE efp_follow_sponsorship_daily_budgets
        SET reserved_transactions = reserved_transactions - ?2, updated_at = ?3
        WHERE budget_date = ?1
      `,
      args: [previousBudgetDate, reservationTransfer, input.now],
    })
  }
  if (reservationNeeded + reservationTransfer > 0) {
    await input.tx.execute({
      sql: `
        UPDATE efp_follow_sponsorship_daily_budgets
        SET reserved_transactions = reserved_transactions + ?2, updated_at = ?3
        WHERE budget_date = ?1
      `,
      args: [budgetDate, reservationNeeded + reservationTransfer, input.now],
    })
  }
  const reviewAfter = new Date(Date.parse(input.now) + SPONSORSHIP_REVIEW_WINDOW_MS).toISOString()
  await input.tx.execute({
    sql: `
      UPDATE efp_follow_write_intents
      SET status = 'submitting',
          sponsorship_reserved_transaction_count =
            CASE WHEN sponsorship_reserved_transaction_count = 0 THEN ?2
                 ELSE sponsorship_reserved_transaction_count END,
          sponsorship_budget_date = ?4,
          sponsorship_review_after = ?5,
          last_error = NULL,
          updated_at = ?3
      WHERE follow_write_intent_id = ?1
    `,
    args: [input.request.intentId, reservationNeeded, input.now, budgetDate, reviewAfter],
  })
}

async function releaseReservation(input: {
  client: Client
  intentId: string
  now: string
  error: string
}): Promise<void> {
  await withTransaction(input.client, "write", async (tx) => {
    const result = await tx.execute({
      sql: `
        SELECT sponsorship_reserved_transaction_count, sponsorship_budget_date
        FROM efp_follow_write_intents
        WHERE follow_write_intent_id = ?1
        FOR UPDATE
      `,
      args: [input.intentId],
    })
    const reserved = result.rows[0]
      ? numberValue(result.rows[0], "sponsorship_reserved_transaction_count")
      : 0
    const budgetDate = result.rows[0]?.sponsorship_budget_date == null
      ? null
      : String(result.rows[0].sponsorship_budget_date).slice(0, 10)
    if (reserved > 0 && !budgetDate) {
      throw conflictError("Follow sponsorship reservation has no budget date")
    }
    await tx.execute({
      sql: `
        UPDATE efp_follow_sponsorship_daily_budgets
        SET reserved_transactions = GREATEST(0, reserved_transactions - ?1), updated_at = ?2
        WHERE budget_date = ?3
      `,
      args: [reserved, input.now, budgetDate],
    })
    await tx.execute({
      sql: `
        UPDATE efp_follow_write_intents
        SET status = 'prepared',
            sponsorship_reserved_transaction_count = 0,
            sponsorship_budget_date = NULL,
            sponsorship_review_after = NULL,
            last_error = ?2,
            updated_at = ?3
        WHERE follow_write_intent_id = ?1 AND status = 'submitting'
      `,
      args: [input.intentId, input.error.slice(0, 1_000), input.now],
    })
  })
}

async function recordProviderPending(input: {
  client: Client
  intentId: string
  now: string
  transactionId: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE efp_follow_write_intents
      SET last_error = ?2, updated_at = ?3
      WHERE follow_write_intent_id = ?1 AND status = 'submitting'
    `,
    args: [
      input.intentId,
      `Privy transaction accepted and pending: ${input.transactionId}`.slice(0, 1_000),
      input.now,
    ],
  })
}

async function finalizeSend(input: {
  client: Client
  actorUserId: string
  intentId: string
  txHash: Hex
  now: string
}): Promise<void> {
  await withTransaction(input.client, "write", async (tx) => {
    const result = await tx.execute({
      sql: `
        SELECT prepared_transaction_count, sponsored_transaction_count,
               actor_wallet_address, target_wallet_address, transaction_hashes_json,
               sponsorship_reserved_transaction_count, sponsorship_budget_date
        FROM efp_follow_write_intents
        WHERE follow_write_intent_id = ?1
          AND actor_user_id = ?2
          AND status = 'submitting'
        FOR UPDATE
      `,
      args: [input.intentId, input.actorUserId],
    })
    const row = result.rows[0]
    if (!row) throw conflictError("Follow write intent lost its sponsorship reservation")
    const nextCount = numberValue(row, "sponsored_transaction_count") + 1
    const remainingReservation = numberValue(row, "sponsorship_reserved_transaction_count") - 1
    if (remainingReservation < 0) throw conflictError("Follow sponsorship reservation is invalid")
    const budgetDate = row.sponsorship_budget_date == null
      ? null
      : String(row.sponsorship_budget_date).slice(0, 10)
    if (!budgetDate) throw conflictError("Follow sponsorship reservation has no budget date")
    const complete = nextCount === numberValue(row, "prepared_transaction_count")
    const hashes = Array.isArray(row.transaction_hashes_json)
      ? row.transaction_hashes_json
      : JSON.parse(String(row.transaction_hashes_json))
    hashes.push(input.txHash)
    const budgetUpdate = await tx.execute({
      sql: `
        UPDATE efp_follow_sponsorship_daily_budgets
        SET reserved_transactions = GREATEST(0, reserved_transactions - 1),
            consumed_transactions = consumed_transactions + 1,
            updated_at = ?2
        WHERE budget_date = ?1
      `,
      args: [budgetDate, input.now],
    })
    if (budgetUpdate.rowsAffected !== 1) {
      throw conflictError("Follow sponsorship budget ledger row was not found")
    }
    await tx.execute({
      sql: `
        UPDATE efp_follow_write_intents
        SET sponsored_transaction_count = ?2,
            transaction_hashes_json = ?3,
            status = ?4,
            sponsorship_reserved_transaction_count = ?6,
            sponsorship_budget_date = CASE WHEN ?6 = 0 THEN NULL ELSE sponsorship_budget_date END,
            sponsorship_review_after = CASE WHEN ?6 = 0 THEN NULL ELSE sponsorship_review_after END,
            submitted_at = CASE WHEN ?4 = 'submitted' THEN ?5 ELSE submitted_at END,
            updated_at = ?5
        WHERE follow_write_intent_id = ?1
      `,
      args: [
        input.intentId,
        nextCount,
        JSON.stringify(hashes),
        complete ? "submitted" : "prepared",
        input.now,
        remainingReservation,
      ],
    })
    if (complete) {
      for (const wallet of [String(row.actor_wallet_address), String(row.target_wallet_address)]) {
        await tx.execute({
          sql: `
            INSERT INTO efp_follow_reconciliation_queue (
              wallet_address, requested_by_follow_write_intent_id, status,
              requested_at, available_at, updated_at
            ) VALUES (?1, ?2, 'pending', ?3, ?3, ?3)
            ON CONFLICT (wallet_address) DO UPDATE SET
              requested_by_follow_write_intent_id = excluded.requested_by_follow_write_intent_id,
              status = 'pending',
              requested_at = excluded.requested_at,
              available_at = excluded.available_at,
              completed_at = NULL,
              last_error = NULL,
              updated_at = excluded.updated_at
          `,
          args: [wallet, input.intentId, input.now],
        })
      }
    }
  })
}

export async function relaySponsoredFollowTransaction(input: {
  client: Client
  env: Env
  actorUserId: string
  request: FollowRelayRequest
  now?: Date
  fetcher?: typeof fetch
}): Promise<{ txHash: Hex; consistency: "accepted_not_yet_reflected" }> {
  if (!/^efw_[a-f0-9]{32}$/u.test(input.request.intentId)) throw badRequestError("Invalid follow intent")
  if (!Number.isSafeInteger(input.request.transactionIndex) || input.request.transactionIndex < 0) {
    throw badRequestError("Invalid follow transaction index")
  }
  const config = requiredConfig(input.env)
  const nowDate = input.now ?? new Date()
  validateRequestExpiry(input.request.requestExpiry, nowDate)
  const now = nowDate.toISOString()
  const apiUrl = input.env.PRIVY_API_URL?.replace(/\/+$/u, "") || "https://api.privy.io"
  const fetcher = input.fetcher ?? fetch
  const requestId = privyFollowRequestId(
    input.request.intentId,
    input.request.transactionIndex,
  )
  await withTransaction(input.client, "write", (tx) => loadAndReserve({
    tx,
    env: input.env,
    actorUserId: input.actorUserId,
    request: input.request,
    now,
    config,
  }))

  let response: Response
  try {
    response = await fetcher(
      `${apiUrl}/v1/wallets/${encodeURIComponent(input.request.privyWalletId)}/rpc`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${config.appId}:${config.appSecret}`)}`,
          "content-type": "application/json",
          "privy-app-id": config.appId,
          "privy-authorization-signature": input.request.authorizationSignature,
          "privy-idempotency-key": requestId,
          "privy-request-expiry": input.request.requestExpiry,
        },
        body: JSON.stringify({
          method: "eth_sendTransaction",
          caip2: "eip155:8453",
          chain_type: "ethereum",
          reference_id: requestId,
          sponsor: true,
          params: { transaction: input.request.transaction },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    )
  } catch (error) {
    // Once the provider request has started, a transport timeout is ambiguous:
    // Privy may have accepted it even though this Worker never received the
    // response. Keep the reservation and deterministic request ID so recovery
    // can look it up without permitting a duplicate send.
    await recordProviderPending({
      client: input.client,
      intentId: input.request.intentId,
      now,
      transactionId: requestId,
    })
    const message = error instanceof Error ? error.message : String(error)
    console.warn("[efp-follow-sponsorship] Privy send outcome is unknown", {
      intent_id: input.request.intentId,
      request_id: requestId,
      message: message.slice(0, 500),
    })
    throw eligibilityFailed("Follow sponsorship was submitted and is awaiting confirmation")
  }
  const payload = await response.json().catch(() => null) as PrivyRelayPayload | null
  if (!response.ok) {
    const message = privyErrorMessage(payload, response.status)
    await releaseReservation({ client: input.client, intentId: input.request.intentId, now, error: message })
    throw eligibilityFailed("Follow sponsorship relay rejected the transaction")
  }
  let txHash = transactionHash(payload)
  const transactionId = typeof payload?.data?.transaction_id === "string"
    ? payload.data.transaction_id.trim()
    : ""
  if (!/^0x[a-f0-9]{64}$/u.test(txHash) && transactionId) {
    txHash = await waitForPrivyTransactionHash({
      apiUrl,
      appId: config.appId,
      appSecret: config.appSecret,
      transactionId,
      fetcher,
    }) ?? ""
  }
  if (!/^0x[a-f0-9]{64}$/u.test(txHash)) {
    // Privy accepted the send, so keep the intent in `submitting`. Releasing it
    // would permit the same prepared transaction to be submitted twice.
    if (transactionId) {
      await recordProviderPending({
        client: input.client,
        intentId: input.request.intentId,
        now,
        transactionId,
      })
    }
    throw eligibilityFailed("Follow sponsorship was accepted but is still awaiting an on-chain hash")
  }
  await finalizeSend({
    client: input.client,
    actorUserId: input.actorUserId,
    intentId: input.request.intentId,
    txHash: txHash as Hex,
    now,
  })
  return { txHash: txHash as Hex, consistency: "accepted_not_yet_reflected" }
}

function hashFromPrivyLookup(payload: unknown): Hex | null {
  const candidates = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? [
          payload,
          ...(["data", "transactions", "results"].flatMap((key) => {
            const value = (payload as Record<string, unknown>)[key]
            return Array.isArray(value) ? value : value ? [value] : []
          })),
        ]
      : []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue
    const record = candidate as Record<string, unknown>
    const hash = String(
      record.transaction_hash
        ?? record.hash
        ?? (record.data && typeof record.data === "object"
          ? (record.data as Record<string, unknown>).hash
          : ""),
    ).toLowerCase()
    if (/^0x[a-f0-9]{64}$/u.test(hash)) return hash as Hex
  }
  return null
}

async function hashFromIndexedChainEvidence(input: {
  client: Client
  row: QueryResultRow
}): Promise<Hex | null> {
  const transactionIndex = numberValue(input.row, "sponsored_transaction_count")
  const prepared = asPreparedTransactions(input.row.prepared_transactions_json)
  const expected = prepared[transactionIndex]
  if (!expected) return null
  let result: QueryResult
  if (transactionIndex === 0) {
    result = await input.client.execute({
      sql: `
        SELECT transaction_hash
        FROM efp_list_ops
        WHERE chain_id = ?1
          AND contract_address = ?2
          AND slot = ?3
          AND (
            target_address = ?4
            OR (
              target_address IS NULL
              AND op_version = 1
              AND record_version = 1
              AND record_type = 36
              AND lower(substr(raw_op, length(raw_op) - 39, 40)) =
                  lower(substr(?4, length(?4) - 39, 40))
            )
          )
          AND opcode = ?5
        ORDER BY block_number ASC, transaction_index ASC, log_index ASC
        LIMIT 1
      `,
      args: [
        expected.chain_id,
        expected.to.toLowerCase(),
        String(input.row.list_slot),
        String(input.row.target_wallet_address).toLowerCase(),
        Number(input.row.desired_following) === 1 ? 1 : 2,
      ],
    })
  } else {
    const records = prepared[0]?.to.toLowerCase()
    if (!records) return null
    result = await input.client.execute({
      sql: `
        SELECT primary_event.transaction_hash
        FROM efp_primary_list_events primary_event
        JOIN efp_list_storage_location_events storage_event
          ON storage_event.list_id = primary_event.list_id
        WHERE primary_event.account_address = ?1
          AND storage_event.storage_chain_id = ?2
          AND storage_event.storage_contract_address = ?3
          AND storage_event.storage_slot = ?4
        ORDER BY primary_event.block_number ASC,
                 primary_event.transaction_index ASC,
                 primary_event.log_index ASC
        LIMIT 1
      `,
      args: [
        String(input.row.actor_wallet_address).toLowerCase(),
        Number(input.row.list_chain_id),
        records,
        String(input.row.list_slot),
      ],
    })
  }
  const hash = String(result.rows[0]?.transaction_hash ?? "").toLowerCase()
  return /^0x[a-f0-9]{64}$/u.test(hash) ? hash as Hex : null
}

async function expireAbandonedPreparedIntents(input: {
  client: Client
  now: string
}): Promise<number> {
  const result = await input.client.execute({
    sql: `
      UPDATE efp_follow_write_intents
      SET status = 'expired',
          semantic_attempt_key = NULL,
          last_error = 'Prepared follow intent expired before submission',
          updated_at = ?1
      WHERE status = 'prepared'
        AND expires_at <= ?1
        AND sponsored_transaction_count = 0
        AND sponsorship_reserved_transaction_count = 0
    `,
    args: [input.now],
  })
  return result.rowsAffected ?? 0
}

async function markSubmissionForManualReview(input: {
  client: Client
  intentId: string
  now: string
}): Promise<boolean> {
  return withTransaction(input.client, "write", async (tx) => {
    const result = await tx.execute({
      sql: `
        SELECT sponsorship_reserved_transaction_count, sponsorship_budget_date
        FROM efp_follow_write_intents
        WHERE follow_write_intent_id = ?1
          AND status = 'submitting'
          AND sponsorship_review_after <= ?2
        FOR UPDATE
      `,
      args: [input.intentId, input.now],
    })
    const row = result.rows[0]
    if (!row) return false
    const reserved = numberValue(row, "sponsorship_reserved_transaction_count")
    const budgetDate = row.sponsorship_budget_date == null
      ? null
      : String(row.sponsorship_budget_date).slice(0, 10)
    if (reserved > 0 && !budgetDate) {
      throw conflictError("Follow sponsorship reservation has no budget date")
    }
    if (reserved > 0) {
      await tx.execute({
        sql: `
          UPDATE efp_follow_sponsorship_daily_budgets
          SET reserved_transactions = reserved_transactions - ?2,
              consumed_transactions = consumed_transactions + ?2,
              updated_at = ?3
          WHERE budget_date = ?1
        `,
        args: [budgetDate, reserved, input.now],
      })
    }
    await tx.execute({
      sql: `
        UPDATE efp_follow_write_intents
        SET status = 'manual_review',
            sponsorship_reserved_transaction_count = 0,
            sponsorship_review_after = NULL,
            last_error = 'Submission outcome remained unknown after the review window; budget charged conservatively',
            updated_at = ?2
        WHERE follow_write_intent_id = ?1
      `,
      args: [input.intentId, input.now],
    })
    return true
  })
}

async function recoverManualReviewFromChainEvidence(input: {
  client: Client
  actorUserId: string
  intentId: string
  txHash: Hex
  now: string
}): Promise<void> {
  await withTransaction(input.client, "write", async (tx) => {
    const result = await tx.execute({
      sql: `
        SELECT prepared_transaction_count, sponsored_transaction_count,
               actor_wallet_address, target_wallet_address, transaction_hashes_json,
               sponsorship_budget_date, created_at
        FROM efp_follow_write_intents
        WHERE follow_write_intent_id = ?1
          AND actor_user_id = ?2
          AND status = 'manual_review'
        FOR UPDATE
      `,
      args: [input.intentId, input.actorUserId],
    })
    const row = result.rows[0]
    if (!row) throw conflictError("Follow write intent left manual review before recovery")
    const preparedCount = numberValue(row, "prepared_transaction_count")
    const nextCount = numberValue(row, "sponsored_transaction_count") + 1
    if (nextCount > preparedCount) throw conflictError("Follow sponsorship recovery count is invalid")
    const refundCount = preparedCount - nextCount
    const budgetDate = String(row.sponsorship_budget_date ?? row.created_at).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(budgetDate)) {
      throw conflictError("Follow sponsorship review has no recoverable budget date")
    }
    if (refundCount > 0) {
      const budgetUpdate = await tx.execute({
        sql: `
          UPDATE efp_follow_sponsorship_daily_budgets
          SET consumed_transactions = consumed_transactions - ?2,
              updated_at = ?3
          WHERE budget_date = ?1
            AND consumed_transactions >= ?2
        `,
        args: [budgetDate, refundCount, input.now],
      })
      if (budgetUpdate.rowsAffected !== 1) {
        throw conflictError("Follow sponsorship review budget cannot be reconciled")
      }
    }
    const hashes = Array.isArray(row.transaction_hashes_json)
      ? row.transaction_hashes_json
      : JSON.parse(String(row.transaction_hashes_json))
    hashes.push(input.txHash)
    const complete = nextCount === preparedCount
    await tx.execute({
      sql: `
        UPDATE efp_follow_write_intents
        SET sponsored_transaction_count = ?2,
            transaction_hashes_json = ?3,
            status = ?4,
            sponsorship_budget_date = NULL,
            last_error = 'Recovered sponsored transaction from indexed chain evidence',
            submitted_at = CASE WHEN ?4 = 'submitted' THEN ?5 ELSE submitted_at END,
            updated_at = ?5
        WHERE follow_write_intent_id = ?1
          AND status = 'manual_review'
      `,
      args: [
        input.intentId,
        nextCount,
        JSON.stringify(hashes),
        complete ? "submitted" : "prepared",
        input.now,
      ],
    })
    if (complete) {
      for (const wallet of [String(row.actor_wallet_address), String(row.target_wallet_address)]) {
        await tx.execute({
          sql: `
            INSERT INTO efp_follow_reconciliation_queue (
              wallet_address, requested_by_follow_write_intent_id, status,
              requested_at, available_at, updated_at
            ) VALUES (?1, ?2, 'pending', ?3, ?3, ?3)
            ON CONFLICT (wallet_address) DO UPDATE SET
              requested_by_follow_write_intent_id = excluded.requested_by_follow_write_intent_id,
              status = 'pending',
              requested_at = excluded.requested_at,
              available_at = excluded.available_at,
              completed_at = NULL,
              last_error = NULL,
              updated_at = excluded.updated_at
          `,
          args: [wallet, input.intentId, input.now],
        })
      }
    }
  })
}

async function supersedeDuplicatePartialIntents(input: {
  client: Client
  now: string
}): Promise<number> {
  const duplicates = await input.client.execute({
    sql: `
      SELECT follow_write_intent_id
      FROM (
        SELECT follow_write_intent_id,
               ROW_NUMBER() OVER (
                 PARTITION BY actor_user_id, target_user_id, desired_following
                 ORDER BY created_at ASC, follow_write_intent_id ASC
               ) AS attempt_rank
        FROM efp_follow_write_intents
        WHERE status = 'prepared'
          AND sponsored_transaction_count > 0
          AND sponsored_transaction_count < prepared_transaction_count
      ) ranked
      WHERE attempt_rank > 1
      ORDER BY follow_write_intent_id ASC
    `,
  })
  let superseded = 0
  for (const duplicate of duplicates.rows) {
    const intentId = String(duplicate.follow_write_intent_id)
    await withTransaction(input.client, "write", async (tx) => {
      const result = await tx.execute({
        sql: `
          SELECT sponsorship_reserved_transaction_count, sponsorship_budget_date
          FROM efp_follow_write_intents
          WHERE follow_write_intent_id = ?1 AND status = 'prepared'
          FOR UPDATE
        `,
        args: [intentId],
      })
      const row = result.rows[0]
      if (!row) return
      const reserved = numberValue(row, "sponsorship_reserved_transaction_count")
      const budgetDate = row.sponsorship_budget_date == null
        ? null
        : String(row.sponsorship_budget_date).slice(0, 10)
      if (reserved > 0 && !budgetDate) {
        throw conflictError("Follow sponsorship reservation has no budget date")
      }
      if (reserved > 0) {
        await tx.execute({
          sql: `
            UPDATE efp_follow_sponsorship_daily_budgets
            SET reserved_transactions = reserved_transactions - ?2, updated_at = ?3
            WHERE budget_date = ?1
          `,
          args: [budgetDate, reserved, input.now],
        })
      }
      await tx.execute({
        sql: `
          UPDATE efp_follow_write_intents
          SET status = 'failed',
              semantic_attempt_key = NULL,
              sponsorship_reserved_transaction_count = 0,
              sponsorship_budget_date = NULL,
              sponsorship_review_after = NULL,
              last_error = 'Superseded duplicate bootstrap; confirmed list slot remains intentionally orphaned',
              updated_at = ?2
          WHERE follow_write_intent_id = ?1 AND status = 'prepared'
        `,
        args: [intentId, input.now],
      })
      superseded += 1
    })
  }
  return superseded
}

export async function reconcilePendingPrivyFollowSubmissions(input: {
  client: Client
  env: Env
  now?: Date
  limit?: number
  fetcher?: typeof fetch
}): Promise<{
  examined: number
  recovered: number
  expired: number
  manual_review: number
  superseded: number
}> {
  const config = requiredConfig(input.env)
  const pending = await input.client.execute({
    sql: `
      SELECT follow_write_intent_id, actor_user_id, actor_wallet_address,
             target_wallet_address, desired_following, list_chain_id, list_slot,
             prepared_transactions_json, sponsored_transaction_count,
             sponsorship_review_after, status
      FROM efp_follow_write_intents
      WHERE (status = 'submitting'
             AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '30 seconds')
         OR status = 'manual_review'
      ORDER BY updated_at ASC
      LIMIT ?1
    `,
    args: [Math.max(1, Math.min(input.limit ?? 100, 500))],
  })
  const apiUrl = input.env.PRIVY_API_URL?.replace(/\/+$/u, "") || "https://api.privy.io"
  const fetcher = input.fetcher ?? fetch
  const now = (input.now ?? new Date()).toISOString()
  let recovered = 0
  let manualReview = 0
  for (const row of pending.rows) {
    const intentId = String(row.follow_write_intent_id)
    const actorUserId = String(row.actor_user_id)
    const requestId = privyFollowRequestId(
      intentId,
      numberValue(row, "sponsored_transaction_count"),
    )
    let hash = await hashFromIndexedChainEvidence({ client: input.client, row })
    if (!hash) {
      const response = await fetcher(
        `${apiUrl}/v1/transactions?reference_id=${encodeURIComponent(requestId)}`,
        {
          headers: {
            authorization: `Basic ${btoa(`${config.appId}:${config.appSecret}`)}`,
            "privy-app-id": config.appId,
          },
          signal: AbortSignal.timeout(5_000),
        },
      ).catch(() => null)
      if (response?.ok) {
        hash = hashFromPrivyLookup(await response.json().catch(() => null))
      }
    }
    if (!hash) {
      if (String(row.status) === "submitting" && await markSubmissionForManualReview({
        client: input.client,
        intentId,
        now,
      })) manualReview += 1
      continue
    }
    if (String(row.status) === "manual_review") {
      await recoverManualReviewFromChainEvidence({
        client: input.client,
        actorUserId,
        intentId,
        txHash: hash,
        now,
      })
    } else {
      await finalizeSend({
        client: input.client,
        actorUserId,
        intentId,
        txHash: hash,
        now,
      })
    }
    recovered += 1
  }
  const superseded = await supersedeDuplicatePartialIntents({ client: input.client, now })
  const expired = await expireAbandonedPreparedIntents({ client: input.client, now })
  return {
    examined: pending.rows.length,
    recovered,
    expired,
    manual_review: manualReview,
    superseded,
  }
}
