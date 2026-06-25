import { computeAllocation, type BookingPolicy } from "@pirate/bookings-domain"

import type { Env } from "../../../env"
import type { UserRepository } from "../../auth/repositories"
import { getControlPlaneClient } from "../../runtime-deps"
import { resolveWalletAttachmentAddress } from "../commerce/access"
import { classifyBookingPaymentReceipt } from "../commerce/funding-proof-service"
import { openCommunityReadClient, openCommunityWriteClient } from "../community-read-access"
import {
  createOrGetPaymentIntent,
  expirePaymentIntentIfDue,
  loadPaymentIntent,
  markPaymentIntentRejected,
  markPaymentIntentVerificationFailed,
  markPaymentIntentVerified,
  normalizeTxRef,
  paymentIntentIdForHold,
  reservePaymentIntentForVerification,
  type PaymentIntentRow,
} from "./booking-payment-intent-service"

type CommunityRepository = Parameters<typeof openCommunityReadClient>[1]

interface HoldRow {
  hold_id: string
  host_user_id: string
  booker_user_id: string
  slot_start_utc: string
  slot_end_utc: string
  price_cents: number
  status: string
  expires_at_utc: string
}

interface BookingSnapshot {
  booking_id: string
  community_id: string
  hold_id: string
  host_user_id: string
  booker_user_id: string
  slot_start_utc: string
  slot_end_utc: string
  gross_cents: number
  platform_fee_cents: number
  host_payout_cents: number
  status: string
  funding_tx_ref: string | null
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value)
}

// computeAllocation only reads platformFeeBps (+ half-up rounding); the rest are placeholders.
function feePolicy(platformFeeBps: number): BookingPolicy {
  return {
    platformFeeBps,
    holdTtlSeconds: 600,
    minLeadTimeSeconds: 3600,
    maxAdvanceSeconds: 60 * 86400,
    cancellationWindowSeconds: 86400,
    noShowGraceSeconds: 600,
    refundPolicy: { bookerCancelAfterWindowRefundBps: 0, noShowByBookerRefundBps: 0, noShowByHostRefundBps: 10000 },
    rounding: "half_up",
  }
}

async function loadHold(env: Env, repo: CommunityRepository, communityId: string, holdId: string): Promise<HoldRow | null> {
  const handle = await openCommunityReadClient(env, repo, communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc, price_cents, status, expires_at_utc
            FROM booking_holds WHERE hold_id = ?1`,
      args: [holdId],
    })
    const row = r.rows[0]
    if (!row) return null
    return {
      hold_id: String(row.hold_id),
      host_user_id: String(row.host_user_id),
      booker_user_id: String(row.booker_user_id),
      slot_start_utc: String(row.slot_start_utc),
      slot_end_utc: String(row.slot_end_utc),
      price_cents: asNumber(row.price_cents),
      status: String(row.status),
      expires_at_utc: String(row.expires_at_utc),
    }
  } finally {
    handle.close()
  }
}

async function loadPlatformFeeBps(env: Env, hostUserId: string): Promise<number> {
  const r = await getControlPlaneClient(env).execute({
    sql: `SELECT platform_fee_bps FROM booking_profiles WHERE host_user_id = ?1`,
    args: [hostUserId],
  })
  return asNumber(r.rows[0]?.platform_fee_bps ?? 1000)
}

// Confirm-time host settlement profile: fee + the payout destination that gets snapshotted onto
// the booking. Payout wallet is required at confirm (mirrors the publish gate) so a paid booking
// always has somewhere to settle the host.
async function loadHostSettlement(env: Env, hostUserId: string): Promise<{ platformFeeBps: number; payoutWalletAddress: string | null }> {
  const r = await getControlPlaneClient(env).execute({
    sql: `SELECT platform_fee_bps, payout_wallet_address FROM booking_profiles WHERE host_user_id = ?1`,
    args: [hostUserId],
  })
  const row = r.rows[0]
  return {
    platformFeeBps: asNumber(row?.platform_fee_bps ?? 1000),
    payoutWalletAddress: row?.payout_wallet_address ? String(row.payout_wallet_address) : null,
  }
}

async function loadBookingByHold(env: Env, repo: CommunityRepository, communityId: string, holdId: string): Promise<BookingSnapshot | null> {
  const handle = await openCommunityReadClient(env, repo, communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
                   gross_cents, platform_fee_cents, host_payout_cents, status, funding_tx_ref
            FROM bookings WHERE hold_id = ?1`,
      args: [holdId],
    })
    const row = r.rows[0]
    if (!row) return null
    return {
      booking_id: String(row.booking_id),
      community_id: String(row.community_id),
      hold_id: String(row.hold_id),
      host_user_id: String(row.host_user_id),
      booker_user_id: String(row.booker_user_id),
      slot_start_utc: String(row.slot_start_utc),
      slot_end_utc: String(row.slot_end_utc),
      gross_cents: asNumber(row.gross_cents),
      platform_fee_cents: asNumber(row.platform_fee_cents),
      host_payout_cents: asNumber(row.host_payout_cents),
      status: String(row.status),
      funding_tx_ref: row.funding_tx_ref ? String(row.funding_tx_ref) : null,
    }
  } finally {
    handle.close()
  }
}

// Transition the cross-community lock from hold-lock → permanent booking-lock (clear expiry so
// Slice B's reclaim can never free a confirmed/paid slot). Idempotent + self-repairing: also run
// on repeated confirm to fix a lock a prior partial confirm left non-permanent. If no active lock
// exists for the hold (released/reclaimed), re-establish one so the slot stays guarded.
async function makeBookingLockPermanent(env: Env, input: {
  holdId: string; bookingId: string; hostUserId: string; slotStartUtc: string; slotEndUtc: string; communityId: string; nowUtc: string
}): Promise<void> {
  const cp = getControlPlaneClient(env)
  const updated = await cp.execute({
    sql: `UPDATE booking_host_slot_locks
          SET expires_at_utc = NULL, booking_id = ?2, updated_at = ?3
          WHERE hold_id = ?1 AND status = 'active'`,
    args: [input.holdId, input.bookingId, input.nowUtc],
  })
  if ((updated.rowsAffected ?? 0) > 0) return
  // No active lock for this hold — re-establish a permanent booking-lock. If a same-start active
  // lock already guards the slot, the unique index rejects this; that means the slot is already
  // guarded, so the conflict is ignored (reconciliation is a payout-layer concern).
  try {
    await cp.execute({
      sql: `INSERT INTO booking_host_slot_locks (
              lock_id, host_user_id, slot_start_utc, slot_end_utc, community_id, hold_id, booking_id,
              status, expires_at_utc, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', NULL, ?8, ?8)`,
      args: [`blk_${input.bookingId}`, input.hostUserId, input.slotStartUtc, input.slotEndUtc, input.communityId, input.holdId, input.bookingId, input.nowUtc],
    })
  } catch { /* slot already guarded by another active lock */ }
}

export interface PaymentInstructions {
  payment_intent_id: string
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
  wallet_attachment_required: boolean
}
export type QuoteBookingHoldResult =
  | { ok: false; reason: "hold_not_found" | "hold_expired" }
  | { ok: true; quote: { hold_id: string; gross_cents: number; platform_fee_bps: number; platform_fee_cents: number; host_payout_cents: number; expires_at_utc: string; payment: PaymentInstructions } }

export async function quoteBookingHold(input: {
  env: Env; communityRepository: CommunityRepository; communityId: string; holdId: string; nowUtc: string
}): Promise<QuoteBookingHoldResult> {
  const hold = await loadHold(input.env, input.communityRepository, input.communityId, input.holdId)
  if (!hold) return { ok: false, reason: "hold_not_found" }
  if (hold.expires_at_utc <= input.nowUtc || hold.status !== "active") return { ok: false, reason: "hold_expired" }

  const platformFeeBps = await loadPlatformFeeBps(input.env, hold.host_user_id)
  const allocation = computeAllocation(hold.price_cents, feePolicy(platformFeeBps))
  const fee = allocation.legs.find((l) => l.recipientType === "platform_fee")?.amountCents ?? 0
  const host = allocation.legs.find((l) => l.recipientType === "host")?.amountCents ?? 0
  // Persist the immutable payment intent (durable; replay-validated). Return ONLY payment instructions
  // (deposit address + token/chain/amount) — never payout snapshots or coordinator internals.
  const intent = await createOrGetPaymentIntent({
    env: input.env, communityRepository: input.communityRepository, communityId: input.communityId,
    hold: { hold_id: hold.hold_id, price_cents: hold.price_cents, expires_at_utc: hold.expires_at_utc }, nowUtc: input.nowUtc,
  })
  return {
    ok: true,
    quote: {
      hold_id: hold.hold_id, gross_cents: hold.price_cents, platform_fee_bps: platformFeeBps,
      platform_fee_cents: fee, host_payout_cents: host, expires_at_utc: hold.expires_at_utc,
      payment: {
        payment_intent_id: intent.payment_intent_id, version: intent.version, chain_id: intent.chain_id,
        token_address: intent.token_address, token_decimals: intent.token_decimals, token_symbol: intent.token_symbol,
        recipient_address: intent.recipient_address, amount_atomic: intent.amount_atomic, gross_cents: intent.gross_cents,
        quote_expires_at: intent.quote_expires_at, hold_expires_at: intent.hold_expires_at,
        wallet_attachment_required: intent.wallet_attachment_required === 1,
      },
    },
  }
}

const VERIFICATION_CLAIM_TTL_MS = 60_000

export type ConfirmBookingResult =
  | { ok: false; reason: "hold_not_found" | "hold_not_active" | "hold_expired" | "host_payout_unconfigured" | "payment_pending" | "payment_rejected" | "transaction_already_used" | "verification_in_progress" | "replay_mismatch" }
  | { ok: true; already: boolean; booking: BookingSnapshot }

export async function confirmBookingHold(input: {
  env: Env
  communityRepository: CommunityRepository
  userRepository: UserRepository
  communityId: string
  holdId: string
  bookerUserId: string
  fundingTxRef: string
  walletAttachmentId: string
  nowUtc: string
}): Promise<ConfirmBookingResult> {
  const hold = await loadHold(input.env, input.communityRepository, input.communityId, input.holdId)
  if (!hold) return { ok: false, reason: "hold_not_found" }
  // Ownership: only the hold's original booker may confirm (indistinguishable 404 otherwise).
  if (hold.booker_user_id !== input.bookerUserId) return { ok: false, reason: "hold_not_found" }
  const intentId = paymentIntentIdForHold(hold.hold_id)
  const normTx = normalizeTxRef(input.fundingTxRef)

  // Idempotent replay: an existing booking is returned ONLY after validating intent + hold + booker
  // + funding tx all match (never a stale/foreign booking).
  const existing = await loadBookingByHold(input.env, input.communityRepository, input.communityId, input.holdId)
  if (existing) {
    if (existing.booker_user_id !== input.bookerUserId || existing.hold_id !== hold.hold_id
      || (existing.funding_tx_ref ?? "").toLowerCase() !== normTx) {
      return { ok: false, reason: "replay_mismatch" }
    }
    await makeBookingLockPermanent(input.env, { holdId: hold.hold_id, bookingId: existing.booking_id, hostUserId: hold.host_user_id, slotStartUtc: hold.slot_start_utc, slotEndUtc: hold.slot_end_utc, communityId: input.communityId, nowUtc: input.nowUtc })
    return { ok: true, already: true, booking: existing }
  }

  // Ensure the durable intent exists (idempotent + replay-validated), then expire it if its window passed.
  await createOrGetPaymentIntent({ env: input.env, communityRepository: input.communityRepository, communityId: input.communityId, hold: { hold_id: hold.hold_id, price_cents: hold.price_cents, expires_at_utc: hold.expires_at_utc }, nowUtc: input.nowUtc })
  await expirePaymentIntentIfDue({ env: input.env, communityRepository: input.communityRepository, communityId: input.communityId, intentId, nowUtc: input.nowUtc })
  let intent = await loadPaymentIntent(input.env, input.communityRepository, input.communityId, intentId)
  if (!intent) throw new Error("payment_intent_missing")

  if (intent.status === "consumed") return finalizeFromVerifiedIntent(input, hold, intent)
  if (intent.status === "verification_rejected") return { ok: false, reason: "payment_rejected" }
  if (intent.status === "expired") return { ok: false, reason: "hold_expired" }
  // Resume a durable verified intent DIRECTLY into finalization — no further chain call or payment.
  if (intent.status === "verified") return finalizeFromVerifiedIntent(input, hold, intent)

  if (hold.status !== "active") return { ok: false, reason: "hold_not_active" }
  if (hold.expires_at_utc <= input.nowUtc) return { ok: false, reason: "hold_expired" }

  // Wallet attachment must belong to the booker; its address is the expected on-chain sender.
  const buyerAddress = await resolveWalletAttachmentAddress({ userRepository: input.userRepository, userId: input.bookerUserId, walletAttachmentId: input.walletAttachmentId })

  // CAS reserve the intent for verification (reserves the normalized tx; one concurrent confirm wins).
  const claimToken = crypto.randomUUID()
  const reserved = await reservePaymentIntentForVerification({
    env: input.env, communityRepository: input.communityRepository, communityId: input.communityId,
    intentId, claimToken, claimExpiresAt: new Date(Date.parse(input.nowUtc) + VERIFICATION_CLAIM_TTL_MS).toISOString(),
    normalizedTxRef: normTx, walletAttachmentId: input.walletAttachmentId, nowUtc: input.nowUtc,
  })
  if (!reserved.ok) {
    if (reserved.reason === "reused_tx") return { ok: false, reason: "transaction_already_used" }
    const cur = await loadPaymentIntent(input.env, input.communityRepository, input.communityId, intentId)
    if (cur?.status === "consumed" || cur?.status === "verified") return finalizeFromVerifiedIntent(input, hold, cur)
    if (cur?.status === "verification_rejected") return { ok: false, reason: "payment_rejected" }
    return { ok: false, reason: "verification_in_progress" }
  }

  // Verify the tx against the PERSISTED intent (explicit expected values; classified outcome).
  const outcome = await classifyBookingPaymentReceipt({
    env: input.env, fundingTxRef: normTx,
    expected: { chainId: intent.chain_id, tokenAddress: intent.token_address, recipientAddress: intent.recipient_address, amountAtomic: BigInt(intent.amount_atomic), senderAddress: buyerAddress },
  })
  const claimArgs = { env: input.env, communityRepository: input.communityRepository, communityId: input.communityId, intentId, claimToken, nowUtc: input.nowUtc }
  if (outcome.kind === "pending") { await markPaymentIntentVerificationFailed(claimArgs); return { ok: false, reason: "payment_pending" } }
  if (outcome.kind === "rejected") { await markPaymentIntentRejected(claimArgs); return { ok: false, reason: "payment_rejected" } }
  // verified → durable verified state (records evidence) BEFORE any booking write.
  const transitioned = await markPaymentIntentVerified({ ...claimArgs, verifiedSenderAddress: outcome.senderAddress })
  if (!transitioned) {
    const cur = await loadPaymentIntent(input.env, input.communityRepository, input.communityId, intentId)
    if (cur?.status === "verified" || cur?.status === "consumed") return finalizeFromVerifiedIntent(input, hold, cur)
    return { ok: false, reason: "verification_in_progress" }
  }
  intent = await loadPaymentIntent(input.env, input.communityRepository, input.communityId, intentId)
  if (!intent) throw new Error("payment_intent_missing_after_verify")
  return finalizeFromVerifiedIntent(input, hold, intent)
}

// Atomic finalization from a durable verified (or already-consumed) intent. One DB transaction:
// create-or-retrieve the booking (stable id) gated on the intent being verified/consumed, consume the
// hold, and CAS verified -> consumed. A rollback leaves the intent verified (never partially consumed),
// so a crash resumes here WITHOUT another chain call. Idempotent on replay.
async function finalizeFromVerifiedIntent(
  input: { env: Env; communityRepository: CommunityRepository; communityId: string; holdId: string; bookerUserId: string; nowUtc: string },
  hold: HoldRow,
  intent: PaymentIntentRow,
): Promise<ConfirmBookingResult> {
  const settlement = await loadHostSettlement(input.env, hold.host_user_id)
  if (!settlement.payoutWalletAddress) return { ok: false, reason: "host_payout_unconfigured" }
  const allocation = computeAllocation(hold.price_cents, feePolicy(settlement.platformFeeBps))
  const feeCents = allocation.legs.find((l) => l.recipientType === "platform_fee")?.amountCents ?? 0
  const hostCents = allocation.legs.find((l) => l.recipientType === "host")?.amountCents ?? 0
  const fundingTxRef = intent.claimed_tx_ref ?? ""
  const fundingWalletAddress = intent.verified_sender_address ?? ""
  // Stable, deterministic booking id so finalization replay can never create a second booking.
  const bookingId = `bkg_${hold.hold_id}`

  const write = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const tx = await write.client.transaction("write")
    try {
      // INSERT only if the intent is verified/consumed (conditional source row — no separate read).
      await tx.execute({
        sql: `INSERT OR IGNORE INTO bookings (
                booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
                gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status,
                funding_tx_ref, funding_wallet_address, host_payout_wallet_address, live_room_id, confirmed_at, created_at, updated_at
              )
              SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'confirmed', ?12, ?13, ?14, NULL, ?15, ?15, ?15
              WHERE EXISTS (SELECT 1 FROM booking_payment_intents WHERE payment_intent_id = ?16 AND status IN ('verified', 'consumed'))`,
        args: [bookingId, input.communityId, hold.hold_id, hold.host_user_id, input.bookerUserId,
          hold.slot_start_utc, hold.slot_end_utc, hold.price_cents, settlement.platformFeeBps, feeCents, hostCents,
          fundingTxRef, fundingWalletAddress, settlement.payoutWalletAddress, input.nowUtc, intent.payment_intent_id],
      })
      // Consume the hold only once a booking exists for it.
      await tx.execute({
        sql: `UPDATE booking_holds SET status = 'consumed', updated_at = ?2
              WHERE hold_id = ?1 AND status = 'active' AND EXISTS (SELECT 1 FROM bookings WHERE hold_id = ?1)`,
        args: [hold.hold_id, input.nowUtc],
      })
      // CAS verified -> consumed (records consuming wallet attachment + timestamp). Idempotent.
      await tx.execute({
        sql: `UPDATE booking_payment_intents SET status = 'consumed', consumed_at = ?2,
                consumed_wallet_attachment_id = COALESCE(consumed_wallet_attachment_id, ?3), updated_at = ?2
              WHERE payment_intent_id = ?1 AND status = 'verified'`,
        args: [intent.payment_intent_id, input.nowUtc, intent.consumed_wallet_attachment_id],
      })
      await tx.commit()
    } catch (error) {
      try { await tx.rollback() } catch { /* noop */ }
      throw error
    } finally {
      await write.close()
    }
  } catch (error) {
    // Rollback left the intent verified — surface so the caller/cron resumes finalization (no re-pay).
    throw error
  }

  const booking = await loadBookingByHold(input.env, input.communityRepository, input.communityId, input.holdId)
  if (!booking) throw new Error("booking_missing_after_finalize")
  await makeBookingLockPermanent(input.env, { holdId: hold.hold_id, bookingId: booking.booking_id, hostUserId: hold.host_user_id, slotStartUtc: hold.slot_start_utc, slotEndUtc: hold.slot_end_utc, communityId: input.communityId, nowUtc: input.nowUtc })
  return { ok: true, already: intent.status === "consumed", booking }
}
