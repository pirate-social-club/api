import { executeFirst, type DbExecutor } from "../../../db-helpers"
import { badRequestError, conflictError } from "../../../errors"
import { requiredString, rowValue, stringOrNull } from "../../../sql-row"
import { acquireFunding } from "./acquisition"
import type { FundingAcquisition, FundingSourceAcquireInput, FundingSourceProviderId } from "./types"

export type SpendIntentStatus =
  | "proposed"
  | "approved"
  | "funding_pending"
  | "funded"
  | "funding_confirming"
  | "funding_confirmed"
  // Reserved for full purchase completion (royalty payment, entitlement mint, purchase rows),
  // wired in a later slice. NOT set by the funding bridge — funding_confirmed is its terminal.
  | "settled"
  | "failed"
  | "refundable"

// Conversation-first lifecycle: telegram_user_id is the only identity known up front; the
// requested item (community/asset/quote/purchase), wallet address, provider, and reservation
// all resolve later, so they are nullable here. See 0119_control_plane_spend_intents.sql.
export type SpendIntentRow = {
  spend_intent_id: string
  telegram_user_id: string
  user_id: string | null
  community_id: string | null
  quote_id: string | null
  purchase_id: string | null
  asset_id: string | null
  buyer_address: string | null
  funding_source_provider: string | null
  price_reservation_expires_at: string | null
  funding_route_ref: string | null
  funding_source_tx_ref: string | null
  funding_receipt_tx_ref: string | null
  status: SpendIntentStatus
  failure_reason: string | null
  idempotency_key: string
  created_at: string
  updated_at: string
}

const SPEND_INTENT_COLUMNS = `
  spend_intent_id, telegram_user_id, user_id, community_id, quote_id, purchase_id, asset_id, buyer_address,
  funding_source_provider, price_reservation_expires_at, funding_route_ref, funding_source_tx_ref,
  funding_receipt_tx_ref, status, failure_reason, idempotency_key, created_at, updated_at
`

function toSpendIntentRow(row: unknown): SpendIntentRow {
  return {
    spend_intent_id: requiredString(row, "spend_intent_id"),
    telegram_user_id: requiredString(row, "telegram_user_id"),
    user_id: stringOrNull(rowValue(row, "user_id")),
    community_id: stringOrNull(rowValue(row, "community_id")),
    quote_id: stringOrNull(rowValue(row, "quote_id")),
    purchase_id: stringOrNull(rowValue(row, "purchase_id")),
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    buyer_address: stringOrNull(rowValue(row, "buyer_address")),
    funding_source_provider: stringOrNull(rowValue(row, "funding_source_provider")),
    price_reservation_expires_at: stringOrNull(rowValue(row, "price_reservation_expires_at")),
    funding_route_ref: stringOrNull(rowValue(row, "funding_route_ref")),
    funding_source_tx_ref: stringOrNull(rowValue(row, "funding_source_tx_ref")),
    funding_receipt_tx_ref: stringOrNull(rowValue(row, "funding_receipt_tx_ref")),
    status: requiredString(row, "status") as SpendIntentStatus,
    failure_reason: stringOrNull(rowValue(row, "failure_reason")),
    idempotency_key: requiredString(row, "idempotency_key"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function getSpendIntent(input: {
  client: DbExecutor
  spendIntentId: string
}): Promise<SpendIntentRow | null> {
  const row = await executeFirst(input.client, {
    sql: `SELECT ${SPEND_INTENT_COLUMNS} FROM spend_intents WHERE spend_intent_id = ?1 LIMIT 1`,
    args: [input.spendIntentId],
  })
  return row ? toSpendIntentRow(row) : null
}

async function reloadSpendIntent(client: DbExecutor, spendIntentId: string): Promise<SpendIntentRow> {
  const row = await getSpendIntent({ client, spendIntentId })
  if (!row) {
    throw new Error("spend_intent_missing_after_update")
  }
  return row
}

async function setSpendIntentStatus(
  client: DbExecutor,
  spendIntentId: string,
  status: SpendIntentStatus,
  now: string,
): Promise<SpendIntentRow> {
  await client.execute({
    sql: `UPDATE spend_intents SET status = ?2, updated_at = ?3 WHERE spend_intent_id = ?1`,
    args: [spendIntentId, status, now],
  })
  return await reloadSpendIntent(client, spendIntentId)
}

// States a proposal can begin funding from. proposed is the AI-created proposal; approved is an
// explicitly accepted proposal. Either may transition to funding_pending.
const PROPOSAL_ENTRY_STATES: ReadonlySet<SpendIntentStatus> = new Set(["proposed", "approved"])

// User accepts a proposal and selects a funding provider: proposed/approved -> funding_pending,
// recording the chosen provider. Pre-money transition only — it prepares the intent for the
// buyer's wallet payment. No funds move and nothing is confirmed here.
export async function startSpendIntentFunding(input: {
  client: DbExecutor
  spendIntentId: string
  provider: FundingSourceProviderId
  now: string
  authorize?: (intent: SpendIntentRow) => void | Promise<void>
}): Promise<SpendIntentRow> {
  const intent = await getSpendIntent({ client: input.client, spendIntentId: input.spendIntentId })
  if (!intent) {
    throw badRequestError("Spend intent not found")
  }
  await input.authorize?.(intent)
  if (!PROPOSAL_ENTRY_STATES.has(intent.status)) {
    throw badRequestError("Spend intent cannot begin funding from its current state")
  }
  await input.client.execute({
    sql: `
      UPDATE spend_intents
      SET funding_source_provider = ?2, status = 'funding_pending', updated_at = ?3
      WHERE spend_intent_id = ?1
    `,
    args: [intent.spend_intent_id, input.provider, input.now],
  })
  return await reloadSpendIntent(input.client, intent.spend_intent_id)
}

// Apply a single acquisition poll result to the intent. This is where reservation-window and
// exactly-once binding live — never in the terminal settlement boundary.
export async function recordFundingAcquisition(input: {
  client: DbExecutor
  spendIntentId: string
  acquisition: FundingAcquisition
  now: string
}): Promise<SpendIntentRow> {
  const intent = await getSpendIntent({
    client: input.client,
    spendIntentId: input.spendIntentId,
  })
  if (!intent) {
    throw badRequestError("Spend intent not found")
  }

  // Retain the correlation breadcrumbs for every outcome — failures are exactly when route/TON
  // handles matter most for refund/audit reconciliation. routeRef can exist before/without a
  // TON tx, so it is persisted independently.
  const sourceTxRef = input.acquisition.sourceCorrelation?.sourceTxRef ?? null
  const routeRef = input.acquisition.sourceCorrelation?.routeRef ?? null

  if (input.acquisition.status === "pending") {
    // No Base receipt yet — stay funding_pending, persist correlation breadcrumbs only.
    await input.client.execute({
      sql: `
        UPDATE spend_intents
        SET status = 'funding_pending',
            funding_route_ref = COALESCE(?2, funding_route_ref),
            funding_source_tx_ref = COALESCE(?3, funding_source_tx_ref),
            updated_at = ?4
        WHERE spend_intent_id = ?1
      `,
      args: [intent.spend_intent_id, routeRef, sourceTxRef, input.now],
    })
    return await reloadSpendIntent(input.client, intent.spend_intent_id)
  }

  if (input.acquisition.status === "failed") {
    const nextStatus: SpendIntentStatus = input.acquisition.refundable ? "refundable" : "failed"
    await input.client.execute({
      sql: `
        UPDATE spend_intents
        SET status = ?2,
            failure_reason = ?3,
            funding_route_ref = COALESCE(?4, funding_route_ref),
            funding_source_tx_ref = COALESCE(?5, funding_source_tx_ref),
            updated_at = ?6
        WHERE spend_intent_id = ?1
      `,
      args: [intent.spend_intent_id, nextStatus, input.acquisition.reason, routeRef, sourceTxRef, input.now],
    })
    return await reloadSpendIntent(input.client, intent.spend_intent_id)
  }

  // confirmed: bind the Base USDC tx exactly once.
  const baseRef = input.acquisition.baseUsdcTxRef.trim()
  if (!baseRef) {
    throw badRequestError("Confirmed acquisition is missing a Base USDC tx ref")
  }

  if (intent.funding_receipt_tx_ref) {
    // Idempotent re-poll with the same receipt is a no-op; a different receipt is a conflict.
    if (intent.funding_receipt_tx_ref === baseRef) {
      return intent
    }
    throw conflictError("Spend intent is already bound to a different funding receipt")
  }

  // Funding can only be acquired after a priced confirmation, which sets the reservation. A
  // confirmed receipt with no reservation window is an invalid lifecycle transition.
  if (!intent.price_reservation_expires_at) {
    throw badRequestError("Spend intent has no price reservation window")
  }
  // Reservation window decides whether a (possibly late) receipt settles or refunds. Compare by
  // epoch ms — price_reservation_expires_at is TIMESTAMPTZ, so its serialized form may differ
  // from the ISO `now` and lexicographic comparison would be wrong.
  const reservationMs = Date.parse(intent.price_reservation_expires_at)
  const nowMs = Date.parse(input.now)
  if (Number.isNaN(reservationMs) || Number.isNaN(nowMs)) {
    throw badRequestError("Spend intent has an unparseable timestamp")
  }
  const expired = nowMs > reservationMs
  const nextStatus: SpendIntentStatus = expired ? "refundable" : "funded"

  try {
    await input.client.execute({
      sql: `
        UPDATE spend_intents
        SET funding_receipt_tx_ref = ?2,
            funding_route_ref = COALESCE(?3, funding_route_ref),
            funding_source_tx_ref = COALESCE(?4, funding_source_tx_ref),
            status = ?5,
            updated_at = ?6
        WHERE spend_intent_id = ?1 AND funding_receipt_tx_ref IS NULL
      `,
      args: [intent.spend_intent_id, baseRef, routeRef, sourceTxRef, nextStatus, input.now],
    })
  } catch (error) {
    // Only a UNIQUE(funding_receipt_tx_ref) violation means this Base tx is already bound to
    // another intent. Any other DB error (check/schema/connection) must propagate untouched.
    if (isUniqueConstraintViolation(error)) {
      throw conflictError("Funding receipt is already bound to another spend intent")
    }
    throw error
  }

  return await reloadSpendIntent(input.client, intent.spend_intent_id)
}

// Recognise a unique-constraint violation across the control-plane's backends: libsql/SQLite in
// tests (SQLITE_CONSTRAINT_UNIQUE / "UNIQUE constraint failed") and Neon Postgres in prod
// (SQLSTATE 23505 / "duplicate key value violates unique constraint").
function isUniqueConstraintViolation(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null
  const code = typeof candidate?.code === "string" ? candidate.code.toUpperCase() : ""
  const message = typeof candidate?.message === "string" ? candidate.message.toLowerCase() : ""
  return (
    code === "23505"
    || code.includes("CONSTRAINT_UNIQUE")
    || message.includes("unique constraint failed")
    || message.includes("duplicate key value violates unique constraint")
  )
}

// Drive one funding poll: acquire -> record -> (if funded) confirm funding at the canonical
// boundary with the BASE USDC tx ref, reaching funding_confirmed. `settle` is the only place the
// funding boundary runs; in prod it is
// `(baseUsdcTxRef) => confirmBuyerFundingForSettlement({ ..., fundingTxRef: baseUsdcTxRef })`.
// It is never called with the originating TON tx or a provider-attested receipt. NOTE: this
// confirms/records the funding receipt only — it does NOT complete the purchase (royalties,
// entitlement mint). That full finalization, and the terminal 'settled' state, are a later slice.
export async function advanceSpendIntentFunding(input: {
  client: DbExecutor
  spendIntentId: string
  acquireInput: FundingSourceAcquireInput
  now: string
  settle: (baseUsdcTxRef: string) => Promise<void>
  // Optional override for the acquisition step. Defaults to the provider dispatch (acquireFunding).
  // Used by context-bound resolvers (e.g. the dev TON-testnet resolver that verifies the TON tx
  // against per-intent expectations). The resulting baseUsdcTxRef still flows through the same
  // record + settle path; for dev TON testnet it is a clearly-namespaced mock ref.
  resolveAcquisition?: (acquireInput: FundingSourceAcquireInput) => Promise<FundingAcquisition>
}): Promise<SpendIntentRow> {
  const existing = await getSpendIntent({
    client: input.client,
    spendIntentId: input.spendIntentId,
  })
  if (!existing) {
    throw badRequestError("Spend intent not found")
  }
  // A poll must target the intent's own funding source. Guarding here prevents a poller bug
  // from binding (e.g.) a pirate_checkout Base tx to an omniston_ton intent or vice versa.
  if (existing.funding_source_provider !== input.acquireInput.provider) {
    throw badRequestError("Funding source provider does not match spend intent")
  }

  const acquisition = await (input.resolveAcquisition ?? acquireFunding)(input.acquireInput)
  const intent = await recordFundingAcquisition({
    client: input.client,
    spendIntentId: input.spendIntentId,
    acquisition,
    now: input.now,
  })

  if (intent.status !== "funded") {
    return intent
  }

  await setSpendIntentStatus(input.client, intent.spend_intent_id, "funding_confirming", input.now)
  try {
    await input.settle(intent.funding_receipt_tx_ref as string)
  } catch (error) {
    // Funds already arrived but funding confirmation failed. Policy: revert to `funded`
    // (retryable by a reconciler — the receipt stays bound, so it remains exactly-once) and
    // record the reason. Never leave the intent stranded in `funding_confirming`.
    await input.client.execute({
      sql: `
        UPDATE spend_intents
        SET status = 'funded', failure_reason = ?2, updated_at = ?3
        WHERE spend_intent_id = ?1
      `,
      args: [
        intent.spend_intent_id,
        error instanceof Error ? error.message : String(error),
        input.now,
      ],
    })
    throw error
  }
  // Success clears any prior failure reason. Terminal for this bridge is funding_confirmed — the
  // funding receipt is verified + recorded, but the purchase is NOT yet fully settled.
  await input.client.execute({
    sql: `
      UPDATE spend_intents
      SET status = 'funding_confirmed', failure_reason = NULL, updated_at = ?2
      WHERE spend_intent_id = ?1
    `,
    args: [intent.spend_intent_id, input.now],
  })
  return await reloadSpendIntent(input.client, intent.spend_intent_id)
}
