import { getAddress } from "ethers"

import type { Env } from "../../../env"
import { conflictError } from "../../errors"
import {
  resolvePirateCheckoutOperatorAddress,
  resolvePirateCheckoutSourceChainId,
  resolvePirateCheckoutUsdcTokenAddress,
} from "../commerce/checkout-config"
import { openCommunityReadClient, openCommunityWriteClient } from "../community-read-access"

type CommunityRepository = Parameters<typeof openCommunityReadClient>[1]

export type PaymentIntentStatus =
  | "active" | "verifying" | "verified" | "verification_failed" | "verification_rejected" | "consumed" | "expired" | "superseded"

export interface PaymentIntentRow {
  payment_intent_id: string
  hold_id: string
  version: number
  chain_id: number
  token_address: string
  token_decimals: number
  token_symbol: string
  recipient_address: string
  amount_atomic: string
  gross_cents: number
  quote_expires_at: string
  hold_expires_at: string
  wallet_attachment_required: number
  status: PaymentIntentStatus
  verification_claim_token: string | null
  verification_claim_expires_at: string | null
  claimed_tx_ref: string | null
  verified_sender_address: string | null
  verified_at: string | null
  consumed_wallet_attachment_id: string | null
  consumed_at: string | null
  created_at: string
  updated_at: string
}

export interface HoldForIntent {
  hold_id: string
  price_cents: number
  expires_at_utc: string
}

const USDC_DECIMALS = 6
const USDC_SYMBOL = "USDC"
// 1 USD cent = 10^(decimals-2) atomic units (USDC has 6 decimals → 1 cent = 10_000 atomic).
function centsToAtomicString(cents: number): string { return (BigInt(cents) * 10n ** BigInt(USDC_DECIMALS - 2)).toString() }

export function paymentIntentIdForHold(holdId: string): string { return `bpi_${holdId}` }
// Normalize a transaction hash before any read/compare/uniqueness claim.
export function normalizeTxRef(txRef: string): string { return txRef.trim().toLowerCase() }

const COLS = `payment_intent_id, hold_id, version, chain_id, token_address, token_decimals, token_symbol,
  recipient_address, amount_atomic, gross_cents, quote_expires_at, hold_expires_at, wallet_attachment_required,
  status, verification_claim_token, verification_claim_expires_at, claimed_tx_ref, verified_sender_address,
  verified_at, consumed_wallet_attachment_id, consumed_at, created_at, updated_at`

function toRow(r: Record<string, unknown>): PaymentIntentRow {
  const s = (v: unknown) => (v == null ? null : String(v))
  return {
    payment_intent_id: String(r.payment_intent_id), hold_id: String(r.hold_id), version: Number(r.version),
    chain_id: Number(r.chain_id), token_address: String(r.token_address), token_decimals: Number(r.token_decimals),
    token_symbol: String(r.token_symbol), recipient_address: String(r.recipient_address), amount_atomic: String(r.amount_atomic),
    gross_cents: Number(r.gross_cents), quote_expires_at: String(r.quote_expires_at), hold_expires_at: String(r.hold_expires_at),
    wallet_attachment_required: Number(r.wallet_attachment_required), status: String(r.status) as PaymentIntentStatus,
    verification_claim_token: s(r.verification_claim_token), verification_claim_expires_at: s(r.verification_claim_expires_at),
    claimed_tx_ref: s(r.claimed_tx_ref), verified_sender_address: s(r.verified_sender_address), verified_at: s(r.verified_at),
    consumed_wallet_attachment_id: s(r.consumed_wallet_attachment_id), consumed_at: s(r.consumed_at),
    created_at: String(r.created_at), updated_at: String(r.updated_at),
  }
}

export async function loadPaymentIntent(env: Env, repo: CommunityRepository, communityId: string, intentId: string): Promise<PaymentIntentRow | null> {
  const handle = await openCommunityReadClient(env, repo, communityId)
  try {
    const r = await handle.client.execute({ sql: `SELECT ${COLS} FROM booking_payment_intents WHERE payment_intent_id = ?1`, args: [intentId] })
    return r.rows[0] ? toRow(r.rows[0] as Record<string, unknown>) : null
  } finally { await handle.close() }
}

// Derive the immutable intent fields for a hold from the hold + current config. Deterministic.
function deriveIntent(env: Env, hold: HoldForIntent): Pick<PaymentIntentRow, "chain_id" | "token_address" | "token_decimals" | "token_symbol" | "recipient_address" | "amount_atomic" | "gross_cents"> {
  return {
    chain_id: resolvePirateCheckoutSourceChainId(env),
    token_address: getAddress(resolvePirateCheckoutUsdcTokenAddress(env)),
    token_decimals: USDC_DECIMALS,
    token_symbol: USDC_SYMBOL,
    recipient_address: getAddress(resolvePirateCheckoutOperatorAddress(env)),
    amount_atomic: centsToAtomicString(hold.price_cents),
    gross_cents: hold.price_cents,
  }
}

/**
 * One immutable intent per hold (deterministic id). INSERT OR IGNORE then load + REPLAY-VALIDATE: a
 * re-quote returns the same intent only if every immutable field matches the newly-derived values;
 * any mismatch is a conflict, never a silent stale instruction.
 */
export async function createOrGetPaymentIntent(input: {
  env: Env; communityRepository: CommunityRepository; communityId: string; hold: HoldForIntent; nowUtc: string
}): Promise<PaymentIntentRow> {
  const id = paymentIntentIdForHold(input.hold.hold_id)
  const d = deriveIntent(input.env, input.hold)
  const write = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await write.client.execute({
      sql: `INSERT OR IGNORE INTO booking_payment_intents (
              payment_intent_id, hold_id, version, chain_id, token_address, token_decimals, token_symbol,
              recipient_address, amount_atomic, gross_cents, quote_expires_at, hold_expires_at,
              wallet_attachment_required, status, created_at, updated_at
            ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, 1, 'active', ?11, ?11)`,
      args: [id, input.hold.hold_id, d.chain_id, d.token_address, d.token_decimals, d.token_symbol,
        d.recipient_address, d.amount_atomic, d.gross_cents, input.hold.expires_at_utc, input.nowUtc],
    })
  } finally { await write.close() }

  const row = await loadPaymentIntent(input.env, input.communityRepository, input.communityId, id)
  if (!row) throw new Error("payment_intent_missing_after_upsert")
  // Replay immutable-field validation (mismatch → conflict, never stale).
  if (
    row.chain_id !== d.chain_id || row.token_address !== d.token_address || row.token_decimals !== d.token_decimals ||
    row.token_symbol !== d.token_symbol || row.recipient_address !== d.recipient_address ||
    row.amount_atomic !== d.amount_atomic || row.gross_cents !== d.gross_cents
  ) {
    throw conflictError("Booking payment intent replay does not match the current quote")
  }
  return row
}

async function casUpdate(env: Env, repo: CommunityRepository, communityId: string, sql: string, args: unknown[]): Promise<number> {
  const write = await openCommunityWriteClient(env, repo, communityId)
  try {
    const r = await write.client.execute({ sql, args: args as never[] })
    return r.rowsAffected ?? 0
  } finally { await write.close() }
}

export type ReserveResult = { ok: true } | { ok: false; reason: "not_reservable" | "reused_tx" }

// CAS reserve for verification. Wins from active / verification_failed / an EXPIRED verifying claim.
// Reclaim of an expired claim requires the SAME tx hash + wallet attachment. UNIQUE(claimed_tx_ref)
// rejects a tx already claimed by another intent (reused). Returns ok only if exactly one row claimed.
export async function reservePaymentIntentForVerification(input: {
  env: Env; communityRepository: CommunityRepository; communityId: string
  intentId: string; claimToken: string; claimExpiresAt: string; normalizedTxRef: string; walletAttachmentId: string; nowUtc: string
}): Promise<ReserveResult> {
  try {
    const affected = await casUpdate(input.env, input.communityRepository, input.communityId,
      `UPDATE booking_payment_intents
       SET status = 'verifying', verification_claim_token = ?2, verification_claim_expires_at = ?3,
           claimed_tx_ref = ?4, consumed_wallet_attachment_id = ?5, updated_at = ?6
       WHERE payment_intent_id = ?1
         AND (status IN ('active', 'verification_failed') OR (status = 'verifying' AND verification_claim_expires_at <= ?6))
         AND (claimed_tx_ref IS NULL OR claimed_tx_ref = ?4)
         AND (consumed_wallet_attachment_id IS NULL OR consumed_wallet_attachment_id = ?5)`,
      [input.intentId, input.claimToken, input.claimExpiresAt, input.normalizedTxRef, input.walletAttachmentId, input.nowUtc])
    return affected === 1 ? { ok: true } : { ok: false, reason: "not_reservable" }
  } catch (error) {
    const msg = String((error as { message?: unknown })?.message ?? error).toLowerCase()
    if (msg.includes("unique") || msg.includes("constraint")) return { ok: false, reason: "reused_tx" }
    throw error
  }
}

export async function markPaymentIntentVerified(input: {
  env: Env; communityRepository: CommunityRepository; communityId: string
  intentId: string; claimToken: string; verifiedSenderAddress: string; nowUtc: string
}): Promise<boolean> {
  const affected = await casUpdate(input.env, input.communityRepository, input.communityId,
    `UPDATE booking_payment_intents SET status = 'verified', verified_sender_address = ?3, verified_at = ?4,
       verification_claim_token = NULL, verification_claim_expires_at = NULL, updated_at = ?4
     WHERE payment_intent_id = ?1 AND status = 'verifying' AND verification_claim_token = ?2`,
    [input.intentId, input.claimToken, input.verifiedSenderAddress, input.nowUtc])
  return affected === 1
}

// Transient/pending → retryable. NEVER clears claimed_tx_ref (the same tx resumes).
export async function markPaymentIntentVerificationFailed(input: {
  env: Env; communityRepository: CommunityRepository; communityId: string; intentId: string; claimToken: string; nowUtc: string
}): Promise<boolean> {
  return (await casUpdate(input.env, input.communityRepository, input.communityId,
    `UPDATE booking_payment_intents SET status = 'verification_failed', verification_claim_token = NULL,
       verification_claim_expires_at = NULL, updated_at = ?3
     WHERE payment_intent_id = ?1 AND status = 'verifying' AND verification_claim_token = ?2`,
    [input.intentId, input.claimToken, input.nowUtc])) === 1
}

// Definitive mismatch → terminal. A new payment requires a superseded/new intent (no auto-reuse).
export async function markPaymentIntentRejected(input: {
  env: Env; communityRepository: CommunityRepository; communityId: string; intentId: string; claimToken: string; nowUtc: string
}): Promise<boolean> {
  return (await casUpdate(input.env, input.communityRepository, input.communityId,
    `UPDATE booking_payment_intents SET status = 'verification_rejected', verification_claim_token = NULL,
       verification_claim_expires_at = NULL, updated_at = ?3
     WHERE payment_intent_id = ?1 AND status = 'verifying' AND verification_claim_token = ?2`,
    [input.intentId, input.claimToken, input.nowUtc])) === 1
}

// Expire an unconsumed intent whose quote/hold window has passed (terminal, cannot confirm).
export async function expirePaymentIntentIfDue(input: {
  env: Env; communityRepository: CommunityRepository; communityId: string; intentId: string; nowUtc: string
}): Promise<boolean> {
  return (await casUpdate(input.env, input.communityRepository, input.communityId,
    `UPDATE booking_payment_intents SET status = 'expired', updated_at = ?2
     WHERE payment_intent_id = ?1 AND status IN ('active', 'verifying', 'verification_failed') AND hold_expires_at <= ?2`,
    [input.intentId, input.nowUtc])) === 1
}
