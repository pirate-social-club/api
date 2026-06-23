import { computeAllocation, type BookingPolicy } from "@pirate/bookings-domain"

import type { Env } from "../../../env"
import type { UserRepository } from "../../auth/repositories"
import { getControlPlaneClient } from "../../runtime-deps"
import { resolveWalletAttachmentAddress } from "../commerce/access"
import { verifyPirateCheckoutUsdcFunding } from "../commerce/funding-proof-service"
import { openCommunityReadClient, openCommunityWriteClient } from "../community-read-access"

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

export type QuoteBookingHoldResult =
  | { ok: false; reason: "hold_not_found" | "hold_expired" }
  | { ok: true; quote: { hold_id: string; gross_cents: number; platform_fee_bps: number; platform_fee_cents: number; host_payout_cents: number; expires_at_utc: string } }

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
  return {
    ok: true,
    quote: {
      hold_id: hold.hold_id,
      gross_cents: hold.price_cents,
      platform_fee_bps: platformFeeBps,
      platform_fee_cents: fee,
      host_payout_cents: host,
      expires_at_utc: hold.expires_at_utc,
    },
  }
}

export type ConfirmBookingResult =
  | { ok: false; reason: "hold_not_found" | "hold_not_active" | "hold_expired" | "host_payout_unconfigured" }
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
  // 1) Read hold + any existing booking BEFORE any write (the D1 write tx forbids reads inside).
  const hold = await loadHold(input.env, input.communityRepository, input.communityId, input.holdId)
  if (!hold) return { ok: false, reason: "hold_not_found" }
  // Ownership: only the hold's original booker may confirm it (and only they may retrieve the
  // resulting booking on the idempotent path). Non-owners get an indistinguishable 404.
  if (hold.booker_user_id !== input.bookerUserId) return { ok: false, reason: "hold_not_found" }

  const existing = await loadBookingByHold(input.env, input.communityRepository, input.communityId, input.holdId)
  if (existing) {
    // Idempotent: a booking already exists for this hold — return it, do NOT re-verify or re-charge.
    // Self-repair the lock in case a prior confirm failed to clear its expiry.
    await makeBookingLockPermanent(input.env, {
      holdId: hold.hold_id, bookingId: existing.booking_id, hostUserId: hold.host_user_id,
      slotStartUtc: hold.slot_start_utc, slotEndUtc: hold.slot_end_utc, communityId: input.communityId, nowUtc: input.nowUtc,
    })
    return { ok: true, already: true, booking: existing }
  }
  if (hold.status !== "active") return { ok: false, reason: "hold_not_active" }
  if (hold.expires_at_utc <= input.nowUtc) return { ok: false, reason: "hold_expired" }

  // 2) Verify the on-chain USDC receipt for the hold's gross amount (PR0 verifier; throws on
  // mismatch → no booking written). Reuses the generalized arbitrary-amount entry point.
  const buyerAddress = await resolveWalletAttachmentAddress({
    userRepository: input.userRepository,
    userId: input.bookerUserId,
    walletAttachmentId: input.walletAttachmentId,
  })
  const receipt = await verifyPirateCheckoutUsdcFunding({
    env: input.env,
    quoteId: `booking_hold:${input.holdId}`,
    amountUsd: hold.price_cents / 100,
    buyerAddress,
    fundingTxRef: input.fundingTxRef,
  })

  const settlement = await loadHostSettlement(input.env, hold.host_user_id)
  if (!settlement.payoutWalletAddress) return { ok: false, reason: "host_payout_unconfigured" }
  const allocation = computeAllocation(hold.price_cents, feePolicy(settlement.platformFeeBps))
  const feeCents = allocation.legs.find((l) => l.recipientType === "platform_fee")?.amountCents ?? 0
  const hostCents = allocation.legs.find((l) => l.recipientType === "host")?.amountCents ?? 0
  const platformFeeBps = settlement.platformFeeBps
  // Durable destination snapshots: refund returns to the verified payer; payout goes to the
  // host payout wallet captured here (never re-resolved later).
  const fundingWalletAddress = receipt.fromAddress ?? buyerAddress
  const bookingId = `bkg_${crypto.randomUUID()}`

  // 3) D1 write tx: create the confirmed booking + consume the hold. The bookings(hold_id)
  // partial-unique index is the idempotency/race backstop — a concurrent confirm loses here.
  const write = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const tx = await write.client.transaction("write")
    try {
      await tx.execute({
        sql: `INSERT INTO bookings (
                booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
                gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status,
                funding_tx_ref, funding_wallet_address, host_payout_wallet_address, live_room_id, confirmed_at, created_at, updated_at
              ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'confirmed', ?12, ?13, ?14, NULL, ?15, ?15, ?15)`,
        args: [bookingId, input.communityId, hold.hold_id, hold.host_user_id, input.bookerUserId,
          hold.slot_start_utc, hold.slot_end_utc, hold.price_cents, platformFeeBps, feeCents, hostCents,
          receipt.txRef, fundingWalletAddress, settlement.payoutWalletAddress, input.nowUtc],
      })
      await tx.execute({
        sql: `UPDATE booking_holds SET status = 'consumed', updated_at = ?2 WHERE hold_id = ?1`,
        args: [hold.hold_id, input.nowUtc],
      })
      await tx.commit()
    } catch (error) {
      try { await tx.rollback() } catch { /* already settled */ }
      // Concurrent confirm likely won the hold_id unique index → return the existing booking.
      const raced = await loadBookingByHold(input.env, input.communityRepository, input.communityId, input.holdId)
      if (raced) return { ok: true, already: true, booking: raced }
      throw error
    } finally {
      write.close()
    }
  } catch (error) {
    throw error
  }

  // 4) Make the cross-community lock permanent (clear expiry + attach booking_id) so the Slice B
  // reclaim can never free a confirmed/paid slot. Self-repairing: re-establishes the lock if it
  // was somehow released. Done AFTER the booking exists (the hold's expiry is still future, so
  // reclaim can't fire in the interim).
  await makeBookingLockPermanent(input.env, {
    holdId: hold.hold_id, bookingId, hostUserId: hold.host_user_id,
    slotStartUtc: hold.slot_start_utc, slotEndUtc: hold.slot_end_utc, communityId: input.communityId, nowUtc: input.nowUtc,
  })

  return {
    ok: true,
    already: false,
    booking: {
      booking_id: bookingId,
      community_id: input.communityId,
      hold_id: hold.hold_id,
      host_user_id: hold.host_user_id,
      booker_user_id: input.bookerUserId,
      slot_start_utc: hold.slot_start_utc,
      slot_end_utc: hold.slot_end_utc,
      gross_cents: hold.price_cents,
      platform_fee_cents: feeCents,
      host_payout_cents: hostCents,
      status: "confirmed",
      funding_tx_ref: receipt.txRef,
    },
  }
}
