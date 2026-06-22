import { asNumber, isTruthyFlag, parseJsonArray } from "../lib/communities/bookings/booking-shared-helpers"
import { nullableUnixSeconds, unixSeconds } from "./time"

export interface BookingProfileResponse {
  object: "booking_profile"
  host: string
  display_headline: string | null
  bio: string | null
  topics: string[] | null
  intro_video_ref: string | null
  host_timezone: string
  base_price_cents: number
  default_slot_duration_seconds: number
  platform_fee_bps: number
  is_published: boolean
  created: number
  updated: number
}

export interface AvailabilityRuleResponse {
  object: "availability_rule"
  id: string
  by_weekday: number[]
  start_local: string
  end_local: string
  slot_duration_seconds: number
  effective_from: number | null
  effective_until: number | null
  created: number
  updated: number
}

export interface AvailabilityExceptionResponse {
  object: "availability_exception"
  id: string
  kind: "block" | "open"
  start: number
  end: number
  created: number
}

export interface PriceRuleResponse {
  object: "price_rule"
  id: string
  match_weekday: number[] | null
  match_local_start: string | null
  match_local_end: string | null
  match_duration_seconds: number | null
  price_cents: number
  priority: number
  created: number
  updated: number
}

type Row = Record<string, unknown>

export function serializeBookingProfile(row: Row): BookingProfileResponse {
  return {
    object: "booking_profile",
    host: String(row.host_user_id),
    display_headline: row.display_headline == null ? null : String(row.display_headline),
    bio: row.bio == null ? null : String(row.bio),
    topics: parseJsonArray<string>(row.topics_json),
    intro_video_ref: row.intro_video_ref == null ? null : String(row.intro_video_ref),
    host_timezone: String(row.host_timezone),
    base_price_cents: asNumber(row.base_price_cents),
    default_slot_duration_seconds: asNumber(row.default_slot_duration_seconds),
    platform_fee_bps: asNumber(row.platform_fee_bps),
    is_published: isTruthyFlag(row.is_published),
    created: unixSeconds(String(row.created_at)),
    updated: unixSeconds(String(row.updated_at)),
  }
}

export function emptyBookingProfileResponse(hostUserId: string): { object: "booking_profile"; exists: false; host: string } {
  return { object: "booking_profile", exists: false, host: hostUserId }
}

export function serializeAvailabilityRule(row: Row): AvailabilityRuleResponse {
  return {
    object: "availability_rule",
    id: String(row.rule_id),
    by_weekday: parseJsonArray<number>(row.by_weekday_json) ?? [],
    start_local: String(row.start_local),
    end_local: String(row.end_local),
    slot_duration_seconds: asNumber(row.slot_duration_seconds),
    effective_from: nullableUnixSeconds(
      row.effective_from_utc == null ? null : String(row.effective_from_utc),
    ),
    effective_until: nullableUnixSeconds(
      row.effective_until_utc == null ? null : String(row.effective_until_utc),
    ),
    created: unixSeconds(String(row.created_at)),
    updated: unixSeconds(String(row.updated_at)),
  }
}

export function serializeAvailabilityException(row: Row): AvailabilityExceptionResponse {
  return {
    object: "availability_exception",
    id: String(row.exception_id),
    kind: row.kind === "open" ? "open" : "block",
    start: unixSeconds(String(row.start_utc)),
    end: unixSeconds(String(row.end_utc)),
    created: unixSeconds(String(row.created_at)),
  }
}

export function serializePriceRule(row: Row): PriceRuleResponse {
  return {
    object: "price_rule",
    id: String(row.price_rule_id),
    match_weekday: parseJsonArray<number>(row.match_weekday_json),
    match_local_start: row.match_local_start == null ? null : String(row.match_local_start),
    match_local_end: row.match_local_end == null ? null : String(row.match_local_end),
    match_duration_seconds:
      row.match_duration_seconds == null ? null : asNumber(row.match_duration_seconds),
    price_cents: asNumber(row.price_cents),
    priority: asNumber(row.priority),
    created: unixSeconds(String(row.created_at)),
    updated: unixSeconds(String(row.updated_at)),
  }
}
