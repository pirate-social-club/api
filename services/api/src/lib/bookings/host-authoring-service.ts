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
import type { Env } from "../../env"
import { parseExpectedEvmAddress } from "../evm-signer"
import { getControlPlaneClient } from "../runtime-deps"
import {
  createBookingHostConfigRepository,
  createBookingHostConfigWriteRepository,
} from "./host-config-repository"
import type { AvailabilityException, AvailabilityRule, BookingProfile, PriceRule } from "./types"

export type ServiceOk<T> = { ok: true; data: T }
export type ServiceErr = { ok: false; reason: string; fields?: ValidationError[] }
export type ServiceResult<T> = ServiceOk<T> | ServiceErr

export type ProfileRow = BookingProfile
export type RuleRow = AvailabilityRule
export type ExceptionRow = AvailabilityException
export type PriceRuleRow = PriceRule

// platform_fee_bps is a PLATFORM-controlled commission and must not be settable by
// hosts via self-service profile writes. It is fixed to the platform default here;
// only an operator-gated path may change it. (Security fix: host fee mass-assignment.)
const DEFAULT_PLATFORM_FEE_BPS = 1000

const REQUIRED_PROFILE_FIELDS: ReadonlyArray<keyof BookingProfileInput> = [
  "host_timezone",
  "base_price_cents",
  "default_slot_duration_seconds",
]

type BookingHostConfigReadRepository = ReturnType<typeof createBookingHostConfigRepository>
type BookingHostConfigWriteRepository = ReturnType<typeof createBookingHostConfigWriteRepository>

let repositoriesForTests: {
  read: BookingHostConfigReadRepository
  write: BookingHostConfigWriteRepository
} | null = null

export function setBookingHostConfigRepositoriesForTests(
  repositories: {
    read: BookingHostConfigReadRepository
    write: BookingHostConfigWriteRepository
  } | null,
): void {
  repositoriesForTests = repositories
}

function nowIso(): string {
  return new Date().toISOString()
}

function readRepo(env: Env) {
  if (repositoriesForTests) return repositoriesForTests.read
  return createBookingHostConfigRepository(getControlPlaneClient(env))
}

function writeRepo(env: Env) {
  if (repositoriesForTests) return repositoriesForTests.write
  return createBookingHostConfigWriteRepository(getControlPlaneClient(env))
}

function validatePayoutWallet(input: BookingProfileInput & { payout_wallet_address?: string | null }): ServiceResult<string | null | undefined> {
  if (input.payout_wallet_address === undefined) return { ok: true, data: undefined }
  if (input.payout_wallet_address === null || input.payout_wallet_address === "") return { ok: true, data: null }

  const parsed = parseExpectedEvmAddress(input.payout_wallet_address)
  if (!parsed) {
    return {
      ok: false,
      reason: "validation_failed",
      fields: [{ field: "payout_wallet_address", reason: "must be a valid EVM address" }],
    }
  }
  return { ok: true, data: parsed }
}

function toProfileUpdateInput(
  input: BookingProfileInput & { payout_wallet_address?: string | null },
  payoutWallet: string | null | undefined,
  updatedAt: string,
) {
  return {
    ...(input.display_headline !== undefined ? { displayHeadline: input.display_headline } : {}),
    ...(input.bio !== undefined ? { bio: input.bio } : {}),
    ...(input.topics !== undefined ? { topics: input.topics } : {}),
    ...(input.intro_video_ref !== undefined ? { introVideoRef: input.intro_video_ref } : {}),
    ...(input.host_timezone !== undefined ? { hostTimezone: input.host_timezone } : {}),
    ...(input.base_price_cents !== undefined ? { basePriceCents: input.base_price_cents } : {}),
    ...(input.default_slot_duration_seconds !== undefined ? { defaultSlotDurationSeconds: input.default_slot_duration_seconds } : {}),
    // platform_fee_bps intentionally NOT host-writable (platform-controlled commission).
    ...(payoutWallet !== undefined ? { payoutWalletAddress: payoutWallet } : {}),
    updatedAt,
  }
}

export async function getBookingProfile(env: Env, hostUserId: string): Promise<ProfileRow | null> {
  return readRepo(env).getProfile(hostUserId)
}

export async function upsertBookingProfile(
  env: Env,
  hostUserId: string,
  input: BookingProfileInput & { payout_wallet_address?: string | null },
): Promise<ServiceResult<{ created: boolean; profile: ProfileRow }>> {
  const errors = validateBookingProfileInput(input)
  if (errors.length > 0) return { ok: false, reason: "validation_failed", fields: errors }

  const payoutWallet = validatePayoutWallet(input)
  if (!payoutWallet.ok) return payoutWallet

  const existing = await getBookingProfile(env, hostUserId)
  const repo = writeRepo(env)
  const now = nowIso()

  if (!existing) {
    const missing = REQUIRED_PROFILE_FIELDS.filter((field) => input[field] === undefined)
    if (missing.length > 0) {
      return {
        ok: false,
        reason: "missing_required_fields",
        fields: missing.map((field) => ({ field, reason: "required on first create" })),
      }
    }

    const profile = await repo.createProfile({
      hostUserId,
      displayHeadline: input.display_headline ?? null,
      bio: input.bio ?? null,
      topics: input.topics ?? null,
      introVideoRef: input.intro_video_ref ?? null,
      hostTimezone: input.host_timezone!,
      basePriceCents: input.base_price_cents!,
      defaultSlotDurationSeconds: input.default_slot_duration_seconds!,
      platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
      payoutWalletAddress: payoutWallet.data ?? null,
      isPublished: false,
      createdAt: now,
      updatedAt: now,
    })
    return { ok: true, data: { created: true, profile } }
  }

  const profile = await repo.updateProfile(hostUserId, toProfileUpdateInput(input, payoutWallet.data, now))
  return { ok: true, data: { created: false, profile: profile! } }
}

export async function setProfilePublished(
  env: Env,
  hostUserId: string,
  published: boolean,
): Promise<ServiceResult<ProfileRow>> {
  const repo = writeRepo(env)
  if (published) {
    const profile = await getBookingProfile(env, hostUserId)
    if (!profile) return { ok: false, reason: "profile_not_found" }
    if (!profile.payoutWalletAddress) return { ok: false, reason: "payout_wallet_required" }
  }

  const profile = published
    ? await repo.publishProfile(hostUserId, nowIso())
    : await repo.unpublishProfile(hostUserId, nowIso())
  if (!profile) return { ok: false, reason: "profile_not_found" }
  return { ok: true, data: profile }
}

async function checkProfileExists(env: Env, hostUserId: string): Promise<boolean> {
  return (await getBookingProfile(env, hostUserId)) !== null
}

export async function listAvailabilityRules(env: Env, hostUserId: string): Promise<RuleRow[]> {
  return readRepo(env).listAvailabilityRules(hostUserId)
}

export async function createAvailabilityRule(
  env: Env,
  hostUserId: string,
  input: AvailabilityRuleInput,
): Promise<ServiceResult<RuleRow>> {
  const errors = validateAvailabilityRuleInput(input)
  if (errors.length > 0) return { ok: false, reason: "validation_failed", fields: errors }
  if (!(await checkProfileExists(env, hostUserId))) return { ok: false, reason: "profile_not_found" }

  const existingRules = await listAvailabilityRules(env, hostUserId)
  if (existingRules.length >= MAX_AVAILABILITY_RULES_PER_HOST) return { ok: false, reason: "limit_exceeded" }

  const now = nowIso()
  const rule = await writeRepo(env).createAvailabilityRule({
    ruleId: `bar_${crypto.randomUUID()}`,
    hostUserId,
    byWeekday: input.by_weekday,
    startLocal: input.start_local,
    endLocal: input.end_local,
    slotDurationSeconds: input.slot_duration_seconds,
    effectiveFromUtc: input.effective_from_utc ?? null,
    effectiveUntilUtc: input.effective_until_utc ?? null,
    createdAt: now,
    updatedAt: now,
  })
  return { ok: true, data: rule }
}

export async function updateAvailabilityRule(
  env: Env,
  hostUserId: string,
  ruleId: string,
  input: Partial<AvailabilityRuleInput>,
): Promise<ServiceResult<RuleRow>> {
  const existing = (await listAvailabilityRules(env, hostUserId)).find((rule) => rule.ruleId === ruleId)
  if (!existing) return { ok: false, reason: "not_found" }

  const merged: AvailabilityRuleInput = {
    by_weekday: input.by_weekday ?? existing.byWeekday,
    start_local: input.start_local ?? existing.startLocal,
    end_local: input.end_local ?? existing.endLocal,
    slot_duration_seconds: input.slot_duration_seconds ?? existing.slotDurationSeconds,
    effective_from_utc: input.effective_from_utc !== undefined ? input.effective_from_utc : existing.effectiveFromUtc ?? undefined,
    effective_until_utc: input.effective_until_utc !== undefined ? input.effective_until_utc : existing.effectiveUntilUtc ?? undefined,
  }
  const errors = validateAvailabilityRuleInput(merged)
  if (errors.length > 0) return { ok: false, reason: "validation_failed", fields: errors }

  const updated = await writeRepo(env).updateAvailabilityRule(hostUserId, ruleId, {
    ...(input.by_weekday !== undefined ? { byWeekday: input.by_weekday } : {}),
    ...(input.start_local !== undefined ? { startLocal: input.start_local } : {}),
    ...(input.end_local !== undefined ? { endLocal: input.end_local } : {}),
    ...(input.slot_duration_seconds !== undefined ? { slotDurationSeconds: input.slot_duration_seconds } : {}),
    ...(input.effective_from_utc !== undefined ? { effectiveFromUtc: input.effective_from_utc ?? null } : {}),
    ...(input.effective_until_utc !== undefined ? { effectiveUntilUtc: input.effective_until_utc ?? null } : {}),
    updatedAt: nowIso(),
  })
  return { ok: true, data: updated! }
}

export async function deleteAvailabilityRule(env: Env, hostUserId: string, ruleId: string): Promise<boolean> {
  return writeRepo(env).deleteAvailabilityRule(hostUserId, ruleId)
}

export async function listAvailabilityExceptions(env: Env, hostUserId: string): Promise<ExceptionRow[]> {
  return readRepo(env).listAvailabilityExceptions(hostUserId)
}

export async function createAvailabilityException(
  env: Env,
  hostUserId: string,
  input: AvailabilityExceptionInput,
): Promise<ServiceResult<ExceptionRow>> {
  const errors = validateAvailabilityExceptionInput(input)
  if (errors.length > 0) return { ok: false, reason: "validation_failed", fields: errors }
  if (!(await checkProfileExists(env, hostUserId))) return { ok: false, reason: "profile_not_found" }

  const existingExceptions = await listAvailabilityExceptions(env, hostUserId)
  if (existingExceptions.length >= MAX_AVAILABILITY_EXCEPTIONS_PER_HOST) return { ok: false, reason: "limit_exceeded" }

  const exception = await writeRepo(env).createAvailabilityException({
    exceptionId: `bae_${crypto.randomUUID()}`,
    hostUserId,
    kind: input.kind,
    startUtc: input.start_utc,
    endUtc: input.end_utc,
    createdAt: nowIso(),
  })
  return { ok: true, data: exception }
}

export async function updateAvailabilityException(
  env: Env,
  hostUserId: string,
  exceptionId: string,
  input: Partial<AvailabilityExceptionInput>,
): Promise<ServiceResult<ExceptionRow>> {
  const existing = (await listAvailabilityExceptions(env, hostUserId)).find((exception) => exception.exceptionId === exceptionId)
  if (!existing) return { ok: false, reason: "not_found" }

  const merged: AvailabilityExceptionInput = {
    kind: input.kind ?? existing.kind,
    start_utc: input.start_utc ?? existing.startUtc,
    end_utc: input.end_utc ?? existing.endUtc,
  }
  const errors = validateAvailabilityExceptionInput(merged)
  if (errors.length > 0) return { ok: false, reason: "validation_failed", fields: errors }

  const updated = await writeRepo(env).updateAvailabilityException(hostUserId, exceptionId, {
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.start_utc !== undefined ? { startUtc: input.start_utc } : {}),
    ...(input.end_utc !== undefined ? { endUtc: input.end_utc } : {}),
  })
  return { ok: true, data: updated! }
}

export async function deleteAvailabilityException(env: Env, hostUserId: string, exceptionId: string): Promise<boolean> {
  return writeRepo(env).deleteAvailabilityException(hostUserId, exceptionId)
}

export async function listPriceRules(env: Env, hostUserId: string): Promise<PriceRuleRow[]> {
  return readRepo(env).listPriceRules(hostUserId)
}

export async function createPriceRule(
  env: Env,
  hostUserId: string,
  input: PriceRuleInput,
  priority: number,
): Promise<ServiceResult<PriceRuleRow>> {
  const errors = validatePriceRuleInput(input)
  if (errors.length > 0) return { ok: false, reason: "validation_failed", fields: errors }
  if (!(await checkProfileExists(env, hostUserId))) return { ok: false, reason: "profile_not_found" }

  const existingRules = await listPriceRules(env, hostUserId)
  if (existingRules.length >= MAX_PRICE_RULES_PER_HOST) return { ok: false, reason: "limit_exceeded" }

  const now = nowIso()
  const priceRule = await writeRepo(env).createPriceRule({
    priceRuleId: `bprl_${crypto.randomUUID()}`,
    hostUserId,
    matchWeekday: input.match_weekday ?? null,
    matchLocalStart: input.match_local_start ?? null,
    matchLocalEnd: input.match_local_end ?? null,
    matchDurationSeconds: input.match_duration_seconds ?? null,
    priceCents: input.price_cents,
    priority,
    createdAt: now,
    updatedAt: now,
  })
  return { ok: true, data: priceRule }
}

export async function updatePriceRule(
  env: Env,
  hostUserId: string,
  priceRuleId: string,
  input: Partial<PriceRuleInput> & { priority?: number },
): Promise<ServiceResult<PriceRuleRow>> {
  const existing = (await listPriceRules(env, hostUserId)).find((priceRule) => priceRule.priceRuleId === priceRuleId)
  if (!existing) return { ok: false, reason: "not_found" }

  const merged: PriceRuleInput = {
    match_weekday: input.match_weekday !== undefined ? input.match_weekday : existing.matchWeekday ?? undefined,
    match_local_start: input.match_local_start !== undefined ? input.match_local_start : existing.matchLocalStart ?? undefined,
    match_local_end: input.match_local_end !== undefined ? input.match_local_end : existing.matchLocalEnd ?? undefined,
    match_duration_seconds: input.match_duration_seconds !== undefined
      ? input.match_duration_seconds
      : existing.matchDurationSeconds ?? undefined,
    price_cents: input.price_cents ?? existing.priceCents,
  }
  const errors = validatePriceRuleInput(merged)
  if (errors.length > 0) return { ok: false, reason: "validation_failed", fields: errors }

  const updated = await writeRepo(env).updatePriceRule(hostUserId, priceRuleId, {
    ...(input.match_weekday !== undefined ? { matchWeekday: input.match_weekday ?? null } : {}),
    ...(input.match_local_start !== undefined ? { matchLocalStart: input.match_local_start ?? null } : {}),
    ...(input.match_local_end !== undefined ? { matchLocalEnd: input.match_local_end ?? null } : {}),
    ...(input.match_duration_seconds !== undefined ? { matchDurationSeconds: input.match_duration_seconds ?? null } : {}),
    ...(input.price_cents !== undefined ? { priceCents: input.price_cents } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    updatedAt: nowIso(),
  })
  return { ok: true, data: updated! }
}

export async function deletePriceRule(env: Env, hostUserId: string, priceRuleId: string): Promise<boolean> {
  return writeRepo(env).deletePriceRule(hostUserId, priceRuleId)
}
