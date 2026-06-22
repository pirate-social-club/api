import {
  resolveSlots,
  type AvailabilityException,
  type AvailabilityRule,
  type BookingPolicy,
  type BusyInterval,
  type PriceRule,
  type ResolvedSlot,
} from "@pirate/bookings-domain"

import { asNumber, isTruthyFlag, parseWeekdayJson } from "./booking-shared-helpers"
import type { Env } from "../../../env"
import { getControlPlaneClient } from "../../runtime-deps"
import { openCommunityReadClient } from "../community-read-access"

// Booking statuses whose slot time is committed (and therefore unavailable). Mirrors the
// control-plane double-book guard set. Terminal/released states (expired_hold,
// cancelled_*, refunded) are intentionally excluded so a released slot can be rebooked.
const OCCUPYING_BOOKING_STATUSES = [
  "pending_payment",
  "confirmed",
  "live",
  "completed",
  "settled",
] as const

type CommunityRepository = Parameters<typeof openCommunityReadClient>[1]

export interface BookingAvailabilityInput {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  hostUserId: string
  windowStartUtc: string
  windowEndUtc: string
  viewerTimezone: string
  nowUtc: string
}

export type BookingAvailabilityResult =
  | { bookable: false }
  | { bookable: true; hostTimezone: string; viewerTimezone: string; slots: ResolvedSlot[] }

// The read path only depends on minLeadTime/maxAdvance (the other policy fields don't affect
// resolveSlots). These are service-level defaults for now; platformFeeBps comes from the profile.
function buildReadPolicy(platformFeeBps: number): BookingPolicy {
  return {
    platformFeeBps,
    holdTtlSeconds: 600,
    minLeadTimeSeconds: 3600,
    maxAdvanceSeconds: 60 * 86400,
    cancellationWindowSeconds: 86400,
    noShowGraceSeconds: 600,
    refundPolicy: {
      bookerCancelAfterWindowRefundBps: 0,
      noShowByBookerRefundBps: 0,
      noShowByHostRefundBps: 10000,
    },
    rounding: "half_up",
  }
}

export async function resolveBookingAvailability(
  input: BookingAvailabilityInput,
): Promise<BookingAvailabilityResult> {
  const cp = getControlPlaneClient(input.env)

  // 1) Host profile (control-plane). Only a published profile is bookable.
  const profileResult = await cp.execute({
    sql: `SELECT host_timezone, base_price_cents, platform_fee_bps, is_published
          FROM booking_profiles WHERE host_user_id = ?1`,
    args: [input.hostUserId],
  })
  const profile = profileResult.rows[0]
  if (!profile || !isTruthyFlag(profile.is_published)) {
    return { bookable: false }
  }
  const hostTimezone = String(profile.host_timezone)
  const basePriceCents = asNumber(profile.base_price_cents)
  const platformFeeBps = asNumber(profile.platform_fee_bps)

  // 2) Availability rules, exceptions, price rules (control-plane, host-owned).
  const rulesResult = await cp.execute({
    sql: `SELECT by_weekday_json, start_local, end_local, slot_duration_seconds,
                 effective_from_utc, effective_until_utc
          FROM booking_availability_rules WHERE host_user_id = ?1`,
    args: [input.hostUserId],
  })
  const exceptionsResult = await cp.execute({
    sql: `SELECT kind, start_utc, end_utc
          FROM booking_availability_exceptions WHERE host_user_id = ?1`,
    args: [input.hostUserId],
  })
  const priceRulesResult = await cp.execute({
    sql: `SELECT match_weekday_json, match_local_start, match_local_end,
                 match_duration_seconds, price_cents
          FROM booking_price_rules WHERE host_user_id = ?1
          ORDER BY priority DESC, price_rule_id ASC`,
    args: [input.hostUserId],
  })

  const rules: AvailabilityRule[] = rulesResult.rows.flatMap((row) => {
    const byWeekday = parseWeekdayJson(row.by_weekday_json)
    if (!byWeekday) return []
    return [{
      hostTimezone, // host timezone lives on the profile, applied to every rule
      byWeekday,
      startLocal: String(row.start_local),
      endLocal: String(row.end_local),
      slotDurationSeconds: asNumber(row.slot_duration_seconds),
      ...(row.effective_from_utc ? { effectiveFromUtc: String(row.effective_from_utc) } : {}),
      ...(row.effective_until_utc ? { effectiveUntilUtc: String(row.effective_until_utc) } : {}),
    }]
  })

  const exceptions: AvailabilityException[] = exceptionsResult.rows.map((row) => ({
    kind: row.kind === "open" ? "open" : "block",
    startUtc: String(row.start_utc),
    endUtc: String(row.end_utc),
  }))

  const priceRules: PriceRule[] = priceRulesResult.rows.map((row) => {
    const matchWeekday = parseWeekdayJson(row.match_weekday_json)
    const hasRange = row.match_local_start != null && row.match_local_end != null
    return {
      ...(matchWeekday ? { matchWeekday } : {}),
      ...(hasRange
        ? { matchLocalTimeRange: { startLocal: String(row.match_local_start), endLocal: String(row.match_local_end) } }
        : {}),
      ...(row.match_duration_seconds != null ? { matchDurationSeconds: asNumber(row.match_duration_seconds) } : {}),
      priceCents: asNumber(row.price_cents),
    }
  })

  // 3) Per-community busy intervals: active (un-expired) holds + occupying bookings.
  // The community DB is already scoped to one community, so host_user_id is the discriminator
  // (no redundant community_id filter needed here).
  const readHandle = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  let existingBusyUtc: BusyInterval[]
  try {
    const placeholders = OCCUPYING_BOOKING_STATUSES.map((_, i) => `?${i + 2}`).join(", ")
    const holds = await readHandle.client.execute({
      sql: `SELECT slot_start_utc, slot_end_utc FROM booking_holds
            WHERE host_user_id = ?1 AND status = 'active' AND expires_at_utc > ?2`,
      args: [input.hostUserId, input.nowUtc],
    })
    const bookings = await readHandle.client.execute({
      sql: `SELECT slot_start_utc, slot_end_utc FROM bookings
            WHERE host_user_id = ?1 AND status IN (${placeholders})`,
      args: [input.hostUserId, ...OCCUPYING_BOOKING_STATUSES],
    })
    existingBusyUtc = [...holds.rows, ...bookings.rows].map((row) => ({
      startUtc: String(row.slot_start_utc),
      endUtc: String(row.slot_end_utc),
    }))
  } finally {
    readHandle.close()
  }

  // 4) Domain resolution — identical math to the web preview.
  const slots = resolveSlots({
    rules,
    exceptions,
    existingBusyUtc,
    windowStartUtc: input.windowStartUtc,
    windowEndUtc: input.windowEndUtc,
    hostTimezone,
    viewerTimezone: input.viewerTimezone,
    policy: buildReadPolicy(platformFeeBps),
    nowUtc: input.nowUtc,
    priceRules,
    basePriceCents,
  })

  return { bookable: true, hostTimezone, viewerTimezone: input.viewerTimezone, slots }
}
