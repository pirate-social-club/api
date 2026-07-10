import { asNumber, isTruthyFlag, parseJsonArray } from "../lib/bookings/booking-shared-helpers"
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

type RowRecord = Record<string, unknown>

function asRecord(row: object): RowRecord {
  return row as RowRecord
}

function rowValue(row: object, snakeName: string, camelName: string): unknown {
  const record = asRecord(row)
  return record[snakeName] ?? record[camelName]
}

function isNullishField(row: object, snakeName: string, camelName: string): boolean {
  const record = asRecord(row)
  return record[snakeName] == null && record[camelName] == null
}

function parseArrayField<T>(row: object, snakeName: string, camelName: string): T[] | null {
  const value = rowValue(row, snakeName, camelName)
  if (value === null || value === undefined) return null
  return Array.isArray(value) ? value as T[] : parseJsonArray<T>(value)
}

export function serializeBookingProfile(row: object): BookingProfileResponse {
  const record = asRecord(row)
  return {
    object: "booking_profile",
    host: String(rowValue(row, "host_user_id", "hostUserId")),
    display_headline: isNullishField(row, "display_headline", "displayHeadline")
      ? null
      : String(rowValue(row, "display_headline", "displayHeadline")),
    bio: record.bio == null ? null : String(record.bio),
    topics: parseArrayField<string>(row, "topics_json", "topics"),
    intro_video_ref: isNullishField(row, "intro_video_ref", "introVideoRef")
      ? null
      : String(rowValue(row, "intro_video_ref", "introVideoRef")),
    host_timezone: String(rowValue(row, "host_timezone", "hostTimezone")),
    base_price_cents: asNumber(rowValue(row, "base_price_cents", "basePriceCents")),
    default_slot_duration_seconds: asNumber(rowValue(row, "default_slot_duration_seconds", "defaultSlotDurationSeconds")),
    platform_fee_bps: asNumber(rowValue(row, "platform_fee_bps", "platformFeeBps")),
    is_published: isTruthyFlag(rowValue(row, "is_published", "isPublished")),
    created: unixSeconds(String(rowValue(row, "created_at", "createdAt"))),
    updated: unixSeconds(String(rowValue(row, "updated_at", "updatedAt"))),
  }
}

export function emptyBookingProfileResponse(hostUserId: string): { object: "booking_profile"; exists: false; host: string } {
  return { object: "booking_profile", exists: false, host: hostUserId }
}

export function serializeAvailabilityRule(row: object): AvailabilityRuleResponse {
  const effectiveFrom = rowValue(row, "effective_from_utc", "effectiveFromUtc")
  const effectiveUntil = rowValue(row, "effective_until_utc", "effectiveUntilUtc")
  return {
    object: "availability_rule",
    id: String(rowValue(row, "rule_id", "ruleId")),
    by_weekday: parseArrayField<number>(row, "by_weekday_json", "byWeekday") ?? [],
    start_local: String(rowValue(row, "start_local", "startLocal")),
    end_local: String(rowValue(row, "end_local", "endLocal")),
    slot_duration_seconds: asNumber(rowValue(row, "slot_duration_seconds", "slotDurationSeconds")),
    effective_from: nullableUnixSeconds(effectiveFrom == null ? null : String(effectiveFrom)),
    effective_until: nullableUnixSeconds(effectiveUntil == null ? null : String(effectiveUntil)),
    created: unixSeconds(String(rowValue(row, "created_at", "createdAt"))),
    updated: unixSeconds(String(rowValue(row, "updated_at", "updatedAt"))),
  }
}

export function serializeAvailabilityException(row: object): AvailabilityExceptionResponse {
  const record = asRecord(row)
  return {
    object: "availability_exception",
    id: String(rowValue(row, "exception_id", "exceptionId")),
    kind: record.kind === "open" ? "open" : "block",
    start: unixSeconds(String(rowValue(row, "start_utc", "startUtc"))),
    end: unixSeconds(String(rowValue(row, "end_utc", "endUtc"))),
    created: unixSeconds(String(rowValue(row, "created_at", "createdAt"))),
  }
}

export function serializePriceRule(row: object): PriceRuleResponse {
  const matchLocalStart = rowValue(row, "match_local_start", "matchLocalStart")
  const matchLocalEnd = rowValue(row, "match_local_end", "matchLocalEnd")
  const matchDurationSeconds = rowValue(row, "match_duration_seconds", "matchDurationSeconds")
  return {
    object: "price_rule",
    id: String(rowValue(row, "price_rule_id", "priceRuleId")),
    match_weekday: parseArrayField<number>(row, "match_weekday_json", "matchWeekday"),
    match_local_start: matchLocalStart == null ? null : String(matchLocalStart),
    match_local_end: matchLocalEnd == null ? null : String(matchLocalEnd),
    match_duration_seconds: matchDurationSeconds == null ? null : asNumber(matchDurationSeconds),
    price_cents: asNumber(rowValue(row, "price_cents", "priceCents")),
    priority: asNumber(rowValue(row, "priority", "priority")),
    created: unixSeconds(String(rowValue(row, "created_at", "createdAt"))),
    updated: unixSeconds(String(rowValue(row, "updated_at", "updatedAt"))),
  }
}
