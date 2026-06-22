import { asNumber, parseJsonArray } from "./booking-shared-helpers"
import type { Env } from "../../../env"
import { getControlPlaneClient } from "../../runtime-deps"
import {
  MAX_AVAILABILITY_EXCEPTIONS_PER_HOST,
  MAX_AVAILABILITY_RULES_PER_HOST,
  MAX_PRICE_RULES_PER_HOST,
  validateAvailabilityExceptionInput,
  validateAvailabilityRuleInput,
  validateBookingProfileInput,
  validatePriceRuleInput,
  type AvailabilityExceptionInput,
  type AvailabilityRuleInput,
  type BookingProfileInput,
  type PriceRuleInput,
  type ValidationError,
} from "@pirate/bookings-domain"

type Row = Record<string, unknown>

export type ServiceOk<T> = { ok: true; data: T }
export type ServiceErr = { ok: false; reason: string; fields?: ValidationError[] }
export type ServiceResult<T> = ServiceOk<T> | ServiceErr

export interface ProfileRow extends Row {}
export interface RuleRow extends Row {}
export interface ExceptionRow extends Row {}
export interface PriceRuleRow extends Row {}

const REQUIRED_PROFILE_FIELDS: ReadonlyArray<keyof BookingProfileInput> = [
  "host_timezone",
  "base_price_cents",
  "default_slot_duration_seconds",
]

function nowIso(): string {
  return new Date().toISOString()
}

export async function getBookingProfile(
  env: Env,
  hostUserId: string,
): Promise<ProfileRow | null> {
  const cp = getControlPlaneClient(env)
  const result = await cp.execute({
    sql: `SELECT host_user_id, display_headline, bio, topics_json, intro_video_ref,
                 host_timezone, base_price_cents, default_slot_duration_seconds,
                 platform_fee_bps, is_published, created_at, updated_at
          FROM booking_profiles WHERE host_user_id = ?1`,
    args: [hostUserId],
  })
  return (result.rows[0] as ProfileRow) ?? null
}

export async function upsertBookingProfile(
  env: Env,
  hostUserId: string,
  input: BookingProfileInput,
): Promise<ServiceResult<{ created: boolean; profile: ProfileRow }>> {
  const errors = validateBookingProfileInput(input)
  if (errors.length > 0) {
    return { ok: false, reason: "validation_failed", fields: errors }
  }

  const existing = await getBookingProfile(env, hostUserId)
  const cp = getControlPlaneClient(env)
  const now = nowIso()

  if (!existing) {
    const missing = REQUIRED_PROFILE_FIELDS.filter(
      (f) => input[f] === undefined,
    )
    if (missing.length > 0) {
      return {
        ok: false,
        reason: "missing_required_fields",
        fields: missing.map((f) => ({ field: f, reason: "required on first create" })),
      }
    }

    await cp.execute({
      sql: `INSERT INTO booking_profiles (
              host_user_id, display_headline, bio, topics_json, intro_video_ref,
              host_timezone, base_price_cents, default_slot_duration_seconds,
              platform_fee_bps, is_published, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, false, ?10, ?10)`,
      args: [
        hostUserId,
        input.display_headline ?? null,
        input.bio ?? null,
        input.topics ? JSON.stringify(input.topics) : null,
        input.intro_video_ref ?? null,
        input.host_timezone,
        input.base_price_cents,
        input.default_slot_duration_seconds,
        input.platform_fee_bps ?? 1000,
        now,
      ],
    })

    const profile = await getBookingProfile(env, hostUserId)
    return { ok: true, data: { created: true, profile: profile! } }
  }

  const sets: string[] = []
  const args: unknown[] = [hostUserId]
  let idx = 2

  if (input.display_headline !== undefined) {
    sets.push(`display_headline = ?${idx++}`)
    args.push(input.display_headline)
  }
  if (input.bio !== undefined) {
    sets.push(`bio = ?${idx++}`)
    args.push(input.bio)
  }
  if (input.topics !== undefined) {
    sets.push(`topics_json = ?${idx++}`)
    args.push(input.topics ? JSON.stringify(input.topics) : null)
  }
  if (input.intro_video_ref !== undefined) {
    sets.push(`intro_video_ref = ?${idx++}`)
    args.push(input.intro_video_ref)
  }
  if (input.host_timezone !== undefined) {
    sets.push(`host_timezone = ?${idx++}`)
    args.push(input.host_timezone)
  }
  if (input.base_price_cents !== undefined) {
    sets.push(`base_price_cents = ?${idx++}`)
    args.push(input.base_price_cents)
  }
  if (input.default_slot_duration_seconds !== undefined) {
    sets.push(`default_slot_duration_seconds = ?${idx++}`)
    args.push(input.default_slot_duration_seconds)
  }
  if (input.platform_fee_bps !== undefined) {
    sets.push(`platform_fee_bps = ?${idx++}`)
    args.push(input.platform_fee_bps)
  }

  sets.push(`updated_at = ?${idx++}`)
  args.push(now)

  if (sets.length > 1) {
    await cp.execute({
      sql: `UPDATE booking_profiles SET ${sets.join(", ")} WHERE host_user_id = ?1`,
      args,
    })
  }

  const profile = await getBookingProfile(env, hostUserId)
  return { ok: true, data: { created: false, profile: profile! } }
}

export async function setProfilePublished(
  env: Env,
  hostUserId: string,
  published: boolean,
): Promise<ServiceResult<ProfileRow>> {
  const cp = getControlPlaneClient(env)
  const now = nowIso()
  const result = await cp.execute({
    sql: `UPDATE booking_profiles SET is_published = ?2, updated_at = ?3
          WHERE host_user_id = ?1`,
    args: [hostUserId, published, now],
  })
  if (result.rowsAffected === 0) {
    return { ok: false, reason: "profile_not_found" }
  }
  const profile = await getBookingProfile(env, hostUserId)
  return { ok: true, data: profile! }
}

async function checkProfileExists(env: Env, hostUserId: string): Promise<boolean> {
  const cp = getControlPlaneClient(env)
  const result = await cp.execute({
    sql: `SELECT 1 FROM booking_profiles WHERE host_user_id = ?1`,
    args: [hostUserId],
  })
  return result.rows.length > 0
}

export async function listAvailabilityRules(
  env: Env,
  hostUserId: string,
): Promise<RuleRow[]> {
  const cp = getControlPlaneClient(env)
  const result = await cp.execute({
    sql: `SELECT rule_id, by_weekday_json, start_local, end_local,
                 slot_duration_seconds, effective_from_utc, effective_until_utc,
                 created_at, updated_at
          FROM booking_availability_rules WHERE host_user_id = ?1
          ORDER BY created_at ASC`,
    args: [hostUserId],
  })
  return result.rows as RuleRow[]
}

export async function createAvailabilityRule(
  env: Env,
  hostUserId: string,
  input: AvailabilityRuleInput,
): Promise<ServiceResult<RuleRow>> {
  const errors = validateAvailabilityRuleInput(input)
  if (errors.length > 0) {
    return { ok: false, reason: "validation_failed", fields: errors }
  }
  if (!(await checkProfileExists(env, hostUserId))) {
    return { ok: false, reason: "profile_not_found" }
  }

  const cp = getControlPlaneClient(env)
  const countResult = await cp.execute({
    sql: `SELECT COUNT(*) as cnt FROM booking_availability_rules WHERE host_user_id = ?1`,
    args: [hostUserId],
  })
  const count = Number(countResult.rows[0]?.cnt ?? 0)
  if (count >= MAX_AVAILABILITY_RULES_PER_HOST) {
    return { ok: false, reason: "limit_exceeded" }
  }

  const ruleId = `bar_${crypto.randomUUID()}`
  const now = nowIso()
  await cp.execute({
    sql: `INSERT INTO booking_availability_rules (
            rule_id, host_user_id, by_weekday_json, start_local, end_local,
            slot_duration_seconds, effective_from_utc, effective_until_utc,
            created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    args: [
      ruleId,
      hostUserId,
      JSON.stringify(input.by_weekday),
      input.start_local,
      input.end_local,
      input.slot_duration_seconds,
      input.effective_from_utc ?? null,
      input.effective_until_utc ?? null,
      now,
    ],
  })

  const row = await cp.execute({
    sql: `SELECT rule_id, by_weekday_json, start_local, end_local,
                 slot_duration_seconds, effective_from_utc, effective_until_utc,
                 created_at, updated_at
          FROM booking_availability_rules WHERE rule_id = ?1`,
    args: [ruleId],
  })
  return { ok: true, data: row.rows[0] as RuleRow }
}

export async function updateAvailabilityRule(
  env: Env,
  hostUserId: string,
  ruleId: string,
  input: Partial<AvailabilityRuleInput>,
): Promise<ServiceResult<RuleRow>> {
  const cp = getControlPlaneClient(env)
  const existing = await cp.execute({
    sql: `SELECT by_weekday_json, start_local, end_local, slot_duration_seconds,
                 effective_from_utc, effective_until_utc
          FROM booking_availability_rules WHERE rule_id = ?1 AND host_user_id = ?2`,
    args: [ruleId, hostUserId],
  })
  if (existing.rows.length === 0) {
    return { ok: false, reason: "not_found" }
  }
  const row = existing.rows[0]

  const merged: AvailabilityRuleInput = {
    by_weekday: input.by_weekday ?? parseJsonArray<number>(row.by_weekday_json) ?? [],
    start_local: input.start_local ?? String(row.start_local),
    end_local: input.end_local ?? String(row.end_local),
    slot_duration_seconds: input.slot_duration_seconds ?? asNumber(row.slot_duration_seconds),
    effective_from_utc:
      input.effective_from_utc !== undefined
        ? input.effective_from_utc
        : row.effective_from_utc != null ? String(row.effective_from_utc) : undefined,
    effective_until_utc:
      input.effective_until_utc !== undefined
        ? input.effective_until_utc
        : row.effective_until_utc != null ? String(row.effective_until_utc) : undefined,
  }
  const errors = validateAvailabilityRuleInput(merged)
  if (errors.length > 0) {
    return { ok: false, reason: "validation_failed", fields: errors }
  }

  const sets: string[] = []
  const args: unknown[] = [ruleId, hostUserId]
  let idx = 3

  if (input.by_weekday !== undefined) {
    sets.push(`by_weekday_json = ?${idx++}`)
    args.push(JSON.stringify(input.by_weekday))
  }
  if (input.start_local !== undefined) {
    sets.push(`start_local = ?${idx++}`)
    args.push(input.start_local)
  }
  if (input.end_local !== undefined) {
    sets.push(`end_local = ?${idx++}`)
    args.push(input.end_local)
  }
  if (input.slot_duration_seconds !== undefined) {
    sets.push(`slot_duration_seconds = ?${idx++}`)
    args.push(input.slot_duration_seconds)
  }
  if (input.effective_from_utc !== undefined) {
    sets.push(`effective_from_utc = ?${idx++}`)
    args.push(input.effective_from_utc ?? null)
  }
  if (input.effective_until_utc !== undefined) {
    sets.push(`effective_until_utc = ?${idx++}`)
    args.push(input.effective_until_utc ?? null)
  }

  sets.push(`updated_at = ?${idx++}`)
  args.push(nowIso())

  await cp.execute({
    sql: `UPDATE booking_availability_rules SET ${sets.join(", ")}
          WHERE rule_id = ?1 AND host_user_id = ?2`,
    args,
  })

  const updated = await cp.execute({
    sql: `SELECT rule_id, by_weekday_json, start_local, end_local,
                 slot_duration_seconds, effective_from_utc, effective_until_utc,
                 created_at, updated_at
          FROM booking_availability_rules WHERE rule_id = ?1`,
    args: [ruleId],
  })
  return { ok: true, data: updated.rows[0] as RuleRow }
}

export async function deleteAvailabilityRule(
  env: Env,
  hostUserId: string,
  ruleId: string,
): Promise<boolean> {
  const cp = getControlPlaneClient(env)
  const result = await cp.execute({
    sql: `DELETE FROM booking_availability_rules
          WHERE rule_id = ?1 AND host_user_id = ?2`,
    args: [ruleId, hostUserId],
  })
  return (result.rowsAffected ?? 0) > 0
}

export async function listAvailabilityExceptions(
  env: Env,
  hostUserId: string,
): Promise<ExceptionRow[]> {
  const cp = getControlPlaneClient(env)
  const result = await cp.execute({
    sql: `SELECT exception_id, kind, start_utc, end_utc, created_at
          FROM booking_availability_exceptions WHERE host_user_id = ?1
          ORDER BY start_utc ASC`,
    args: [hostUserId],
  })
  return result.rows as ExceptionRow[]
}

export async function createAvailabilityException(
  env: Env,
  hostUserId: string,
  input: AvailabilityExceptionInput,
): Promise<ServiceResult<ExceptionRow>> {
  const errors = validateAvailabilityExceptionInput(input)
  if (errors.length > 0) {
    return { ok: false, reason: "validation_failed", fields: errors }
  }
  if (!(await checkProfileExists(env, hostUserId))) {
    return { ok: false, reason: "profile_not_found" }
  }

  const cp = getControlPlaneClient(env)
  const countResult = await cp.execute({
    sql: `SELECT COUNT(*) as cnt FROM booking_availability_exceptions WHERE host_user_id = ?1`,
    args: [hostUserId],
  })
  const count = Number(countResult.rows[0]?.cnt ?? 0)
  if (count >= MAX_AVAILABILITY_EXCEPTIONS_PER_HOST) {
    return { ok: false, reason: "limit_exceeded" }
  }

  const exceptionId = `bae_${crypto.randomUUID()}`
  const now = nowIso()
  await cp.execute({
    sql: `INSERT INTO booking_availability_exceptions (
            exception_id, host_user_id, kind, start_utc, end_utc, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    args: [exceptionId, hostUserId, input.kind, input.start_utc, input.end_utc, now],
  })

  const row = await cp.execute({
    sql: `SELECT exception_id, kind, start_utc, end_utc, created_at
          FROM booking_availability_exceptions WHERE exception_id = ?1`,
    args: [exceptionId],
  })
  return { ok: true, data: row.rows[0] as ExceptionRow }
}

export async function deleteAvailabilityException(
  env: Env,
  hostUserId: string,
  exceptionId: string,
): Promise<boolean> {
  const cp = getControlPlaneClient(env)
  const result = await cp.execute({
    sql: `DELETE FROM booking_availability_exceptions
          WHERE exception_id = ?1 AND host_user_id = ?2`,
    args: [exceptionId, hostUserId],
  })
  return (result.rowsAffected ?? 0) > 0
}

export async function updateAvailabilityException(
  env: Env,
  hostUserId: string,
  exceptionId: string,
  input: Partial<AvailabilityExceptionInput>,
): Promise<ServiceResult<ExceptionRow>> {
  const cp = getControlPlaneClient(env)
  const existing = await cp.execute({
    sql: `SELECT kind, start_utc, end_utc
          FROM booking_availability_exceptions WHERE exception_id = ?1 AND host_user_id = ?2`,
    args: [exceptionId, hostUserId],
  })
  if (existing.rows.length === 0) {
    return { ok: false, reason: "not_found" }
  }
  const row = existing.rows[0]

  const merged: AvailabilityExceptionInput = {
    kind: (input.kind ?? (row.kind === "open" ? "open" : "block")) as "block" | "open",
    start_utc: input.start_utc ?? String(row.start_utc),
    end_utc: input.end_utc ?? String(row.end_utc),
  }
  const errors = validateAvailabilityExceptionInput(merged)
  if (errors.length > 0) {
    return { ok: false, reason: "validation_failed", fields: errors }
  }

  const sets: string[] = []
  const args: unknown[] = [exceptionId, hostUserId]
  let idx = 3

  if (input.kind !== undefined) {
    sets.push(`kind = ?${idx++}`)
    args.push(input.kind)
  }
  if (input.start_utc !== undefined) {
    sets.push(`start_utc = ?${idx++}`)
    args.push(input.start_utc)
  }
  if (input.end_utc !== undefined) {
    sets.push(`end_utc = ?${idx++}`)
    args.push(input.end_utc)
  }

  if (sets.length === 0) {
    const unchanged = await cp.execute({
      sql: `SELECT exception_id, kind, start_utc, end_utc, created_at
            FROM booking_availability_exceptions WHERE exception_id = ?1`,
      args: [exceptionId],
    })
    return { ok: true, data: unchanged.rows[0] as ExceptionRow }
  }

  await cp.execute({
    sql: `UPDATE booking_availability_exceptions SET ${sets.join(", ")}
          WHERE exception_id = ?1 AND host_user_id = ?2`,
    args,
  })

  const updated = await cp.execute({
    sql: `SELECT exception_id, kind, start_utc, end_utc, created_at
          FROM booking_availability_exceptions WHERE exception_id = ?1`,
    args: [exceptionId],
  })
  return { ok: true, data: updated.rows[0] as ExceptionRow }
}

export async function listPriceRules(
  env: Env,
  hostUserId: string,
): Promise<PriceRuleRow[]> {
  const cp = getControlPlaneClient(env)
  const result = await cp.execute({
    sql: `SELECT price_rule_id, match_weekday_json, match_local_start, match_local_end,
                 match_duration_seconds, price_cents, priority, created_at, updated_at
          FROM booking_price_rules WHERE host_user_id = ?1
          ORDER BY priority DESC, price_rule_id ASC`,
    args: [hostUserId],
  })
  return result.rows as PriceRuleRow[]
}

export async function createPriceRule(
  env: Env,
  hostUserId: string,
  input: PriceRuleInput,
  priority: number,
): Promise<ServiceResult<PriceRuleRow>> {
  const errors = validatePriceRuleInput(input)
  if (errors.length > 0) {
    return { ok: false, reason: "validation_failed", fields: errors }
  }
  if (!(await checkProfileExists(env, hostUserId))) {
    return { ok: false, reason: "profile_not_found" }
  }

  const cp = getControlPlaneClient(env)
  const countResult = await cp.execute({
    sql: `SELECT COUNT(*) as cnt FROM booking_price_rules WHERE host_user_id = ?1`,
    args: [hostUserId],
  })
  const count = Number(countResult.rows[0]?.cnt ?? 0)
  if (count >= MAX_PRICE_RULES_PER_HOST) {
    return { ok: false, reason: "limit_exceeded" }
  }

  const priceRuleId = `bprl_${crypto.randomUUID()}`
  const now = nowIso()
  await cp.execute({
    sql: `INSERT INTO booking_price_rules (
            price_rule_id, host_user_id, match_weekday_json, match_local_start,
            match_local_end, match_duration_seconds, price_cents, priority,
            created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    args: [
      priceRuleId,
      hostUserId,
      input.match_weekday ? JSON.stringify(input.match_weekday) : null,
      input.match_local_start ?? null,
      input.match_local_end ?? null,
      input.match_duration_seconds ?? null,
      input.price_cents,
      priority,
      now,
    ],
  })

  const row = await cp.execute({
    sql: `SELECT price_rule_id, match_weekday_json, match_local_start, match_local_end,
                 match_duration_seconds, price_cents, priority, created_at, updated_at
          FROM booking_price_rules WHERE price_rule_id = ?1`,
    args: [priceRuleId],
  })
  return { ok: true, data: row.rows[0] as PriceRuleRow }
}

export async function deletePriceRule(
  env: Env,
  hostUserId: string,
  priceRuleId: string,
): Promise<boolean> {
  const cp = getControlPlaneClient(env)
  const result = await cp.execute({
    sql: `DELETE FROM booking_price_rules
          WHERE price_rule_id = ?1 AND host_user_id = ?2`,
    args: [priceRuleId, hostUserId],
  })
  return (result.rowsAffected ?? 0) > 0
}

export async function updatePriceRule(
  env: Env,
  hostUserId: string,
  priceRuleId: string,
  input: Partial<PriceRuleInput> & { priority?: number },
): Promise<ServiceResult<PriceRuleRow>> {
  const cp = getControlPlaneClient(env)
  const existing = await cp.execute({
    sql: `SELECT match_weekday_json, match_local_start, match_local_end,
                 match_duration_seconds, price_cents, priority
          FROM booking_price_rules WHERE price_rule_id = ?1 AND host_user_id = ?2`,
    args: [priceRuleId, hostUserId],
  })
  if (existing.rows.length === 0) {
    return { ok: false, reason: "not_found" }
  }
  const row = existing.rows[0]

  const merged: PriceRuleInput = {
    match_weekday: input.match_weekday !== undefined
      ? input.match_weekday
      : parseJsonArray<number>(row.match_weekday_json) ?? undefined,
    match_local_start: input.match_local_start !== undefined
      ? input.match_local_start
      : row.match_local_start != null ? String(row.match_local_start) : undefined,
    match_local_end: input.match_local_end !== undefined
      ? input.match_local_end
      : row.match_local_end != null ? String(row.match_local_end) : undefined,
    match_duration_seconds: input.match_duration_seconds !== undefined
      ? input.match_duration_seconds
      : row.match_duration_seconds != null ? asNumber(row.match_duration_seconds) : undefined,
    price_cents: input.price_cents ?? asNumber(row.price_cents),
  }
  const errors = validatePriceRuleInput(merged)
  if (errors.length > 0) {
    return { ok: false, reason: "validation_failed", fields: errors }
  }

  const sets: string[] = []
  const args: unknown[] = [priceRuleId, hostUserId]
  let idx = 3

  if (input.match_weekday !== undefined) {
    sets.push(`match_weekday_json = ?${idx++}`)
    args.push(input.match_weekday ? JSON.stringify(input.match_weekday) : null)
  }
  if (input.match_local_start !== undefined) {
    sets.push(`match_local_start = ?${idx++}`)
    args.push(input.match_local_start ?? null)
  }
  if (input.match_local_end !== undefined) {
    sets.push(`match_local_end = ?${idx++}`)
    args.push(input.match_local_end ?? null)
  }
  if (input.match_duration_seconds !== undefined) {
    sets.push(`match_duration_seconds = ?${idx++}`)
    args.push(input.match_duration_seconds ?? null)
  }
  if (input.price_cents !== undefined) {
    sets.push(`price_cents = ?${idx++}`)
    args.push(input.price_cents)
  }
  if (input.priority !== undefined) {
    sets.push(`priority = ?${idx++}`)
    args.push(input.priority)
  }

  sets.push(`updated_at = ?${idx++}`)
  args.push(nowIso())

  await cp.execute({
    sql: `UPDATE booking_price_rules SET ${sets.join(", ")}
          WHERE price_rule_id = ?1 AND host_user_id = ?2`,
    args,
  })

  const updated = await cp.execute({
    sql: `SELECT price_rule_id, match_weekday_json, match_local_start, match_local_end,
                 match_duration_seconds, price_cents, priority, created_at, updated_at
          FROM booking_price_rules WHERE price_rule_id = ?1`,
    args: [priceRuleId],
  })
  return { ok: true, data: updated.rows[0] as PriceRuleRow }
}
