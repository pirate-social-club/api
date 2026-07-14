import type { Client } from "../sql-client";
import { isoUtcFromRow, isoUtcToArg } from "./codecs";
import { createBookingHoldWriteRepository, type BookingHoldSqlExecutor } from "./hold-repository";
import { createBookingHostConfigRepository } from "./host-config-repository";
import type {
  AvailabilityException,
  AvailabilityRule,
  BookingProfile,
  PriceRule,
} from "./types";

const HOLD_TTL_SECONDS = 600;
const OCCUPYING_BOOKING_STATUSES = ["pending_payment", "confirmed", "live", "completed", "settled"] as const;

interface DomainAvailabilityRule {
  hostTimezone: string;
  byWeekday: number[];
  startLocal: string;
  endLocal: string;
  slotDurationSeconds: number;
  effectiveFromUtc?: string;
  effectiveUntilUtc?: string;
}

interface DomainAvailabilityException {
  kind: "block" | "open";
  startUtc: string;
  endUtc: string;
}

interface DomainPriceRule {
  matchWeekday?: number[];
  matchLocalTimeRange?: { startLocal: string; endLocal: string };
  matchDurationSeconds?: number;
  priceCents: number;
}

interface BusyInterval {
  startUtc: string;
  endUtc: string;
}

interface ResolvedBookingSlot {
  startUtc: string;
  endUtc: string;
  priceCents: number;
  available: boolean;
}

interface ResolveSlotsInput {
  rules: DomainAvailabilityRule[];
  exceptions: DomainAvailabilityException[];
  existingBusyUtc: BusyInterval[];
  windowStartUtc: string;
  windowEndUtc: string;
  hostTimezone: string;
  viewerTimezone: string;
  policy: {
    platformFeeBps: number;
    holdTtlSeconds: number;
    minLeadTimeSeconds: number;
    maxAdvanceSeconds: number;
    cancellationWindowSeconds: number;
    noShowGraceSeconds: number;
    refundPolicy: {
      bookerCancelAfterWindowRefundBps: number;
      noShowByBookerRefundBps: number;
      noShowByHostRefundBps: number;
    };
    rounding: "half_up";
  };
  nowUtc: string;
  priceRules: DomainPriceRule[];
  basePriceCents: number;
}

type ResolveSlots = (input: ResolveSlotsInput) => ResolvedBookingSlot[];

let resolveSlotsForTests: ResolveSlots | null = null;

export function setGlobalBookingResolveSlotsForTests(resolver: ResolveSlots | null): void {
  resolveSlotsForTests = resolver;
}

async function resolveSlots(input: ResolveSlotsInput): Promise<ResolvedBookingSlot[]> {
  if (resolveSlotsForTests) return resolveSlotsForTests(input);
  const mod = await import("@pirate/bookings-domain");
  return mod.resolveSlots(input);
}

export interface CreateGlobalBookingHoldInput {
  client: Client;
  sourceCommunityId: string | null;
  hostUserId: string;
  bookerUserId: string;
  slotStartUtc: string;
  slotEndUtc: string;
  nowUtc: string;
}

interface GlobalBookingHoldResponse {
  hold_id: string;
  community_id: string | null;
  source_community_id: string | null;
  host_user_id: string;
  booker_user_id: string;
  slot_start_utc: string;
  slot_end_utc: string;
  price_cents: number;
  status: "active";
  expires_at_utc: string;
}

export type CreateGlobalBookingHoldResult =
  | { ok: true; hold: GlobalBookingHoldResponse }
  | { ok: false; reason: "slot_unavailable" | "slot_locked" };

export type GlobalBookingAvailabilityResult =
  | { bookable: false }
  | { bookable: true; hostTimezone: string; viewerTimezone: string; slots: ResolvedBookingSlot[] };

function buildReadPolicy(platformFeeBps: number): ResolveSlotsInput["policy"] {
  return {
    platformFeeBps,
    holdTtlSeconds: HOLD_TTL_SECONDS,
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
  };
}

function sameInstant(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && left === right;
}

function toDomainRules(profile: BookingProfile, rules: AvailabilityRule[]): DomainAvailabilityRule[] {
  return rules.map((rule) => ({
    hostTimezone: profile.hostTimezone,
    byWeekday: rule.byWeekday,
    startLocal: rule.startLocal,
    endLocal: rule.endLocal,
    slotDurationSeconds: rule.slotDurationSeconds,
    ...(rule.effectiveFromUtc ? { effectiveFromUtc: rule.effectiveFromUtc } : {}),
    ...(rule.effectiveUntilUtc ? { effectiveUntilUtc: rule.effectiveUntilUtc } : {}),
  }));
}

function toDomainExceptions(exceptions: AvailabilityException[]): DomainAvailabilityException[] {
  return exceptions.map((exception) => ({
    kind: exception.kind,
    startUtc: exception.startUtc,
    endUtc: exception.endUtc,
  }));
}

function toDomainPriceRules(priceRules: PriceRule[]): DomainPriceRule[] {
  return priceRules.map((rule) => ({
    ...(rule.matchWeekday ? { matchWeekday: rule.matchWeekday } : {}),
    ...(rule.matchLocalStart && rule.matchLocalEnd
      ? { matchLocalTimeRange: { startLocal: rule.matchLocalStart, endLocal: rule.matchLocalEnd } }
      : {}),
    ...(rule.matchDurationSeconds !== null ? { matchDurationSeconds: rule.matchDurationSeconds } : {}),
    priceCents: rule.priceCents,
  }));
}

async function listGlobalBusyIntervals(
  executor: BookingHoldSqlExecutor,
  hostUserId: string,
  nowUtc: string,
): Promise<BusyInterval[]> {
  const placeholders = OCCUPYING_BOOKING_STATUSES.map((_, index) => `?${index + 3}`).join(", ");
  const res = await executor.execute({
    sql: `SELECT slot_start_utc, slot_end_utc FROM bookings.holds
          WHERE host_user_id = ?1 AND status = 'active' AND expires_at_utc > ?2::timestamptz
          UNION ALL
          SELECT slot_start_utc, slot_end_utc FROM bookings.bookings
          WHERE host_user_id = ?1 AND status IN (${placeholders})`,
    args: [hostUserId, isoUtcToArg(nowUtc), ...OCCUPYING_BOOKING_STATUSES],
  });
  return res.rows.map((row) => ({
    startUtc: isoUtcFromRow(row.slot_start_utc),
    endUtc: isoUtcFromRow(row.slot_end_utc),
  }));
}

export async function resolveGlobalBookingAvailability(input: {
  executor: BookingHoldSqlExecutor;
  hostUserId: string;
  windowStartUtc: string;
  windowEndUtc: string;
  viewerTimezone: string;
  nowUtc: string;
}): Promise<GlobalBookingAvailabilityResult> {
  const config = await createBookingHostConfigRepository(input.executor).getHostConfiguration(input.hostUserId);
  if (!config?.profile.isPublished) return { bookable: false };

  const existingBusyUtc = await listGlobalBusyIntervals(input.executor, input.hostUserId, input.nowUtc);
  const slots = await resolveSlots({
    rules: toDomainRules(config.profile, config.availabilityRules),
    exceptions: toDomainExceptions(config.availabilityExceptions),
    existingBusyUtc,
    windowStartUtc: input.windowStartUtc,
    windowEndUtc: input.windowEndUtc,
    hostTimezone: config.profile.hostTimezone,
    viewerTimezone: input.viewerTimezone,
    policy: buildReadPolicy(config.profile.platformFeeBps),
    nowUtc: input.nowUtc,
    priceRules: toDomainPriceRules(config.priceRules),
    basePriceCents: config.profile.basePriceCents,
  });
  return {
    bookable: true,
    hostTimezone: config.profile.hostTimezone,
    viewerTimezone: input.viewerTimezone,
    slots,
  };
}

function toResponse(input: {
  holdId: string;
  sourceCommunityId: string | null;
  hostUserId: string;
  bookerUserId: string;
  slotStartUtc: string;
  slotEndUtc: string;
  priceCents: number;
  expiresAtUtc: string;
}): GlobalBookingHoldResponse {
  return {
    hold_id: input.holdId,
    community_id: input.sourceCommunityId,
    source_community_id: input.sourceCommunityId,
    host_user_id: input.hostUserId,
    booker_user_id: input.bookerUserId,
    slot_start_utc: input.slotStartUtc,
    slot_end_utc: input.slotEndUtc,
    price_cents: input.priceCents,
    status: "active",
    expires_at_utc: input.expiresAtUtc,
  };
}

export async function createGlobalBookingHold(
  input: CreateGlobalBookingHoldInput,
): Promise<CreateGlobalBookingHoldResult> {
  const availability = await resolveGlobalBookingAvailability({
    executor: input.client,
    hostUserId: input.hostUserId,
    windowStartUtc: input.slotStartUtc,
    windowEndUtc: input.slotEndUtc,
    viewerTimezone: "UTC",
    nowUtc: input.nowUtc,
  });
  if (!availability.bookable) return { ok: false, reason: "slot_unavailable" };
  const slot = availability.slots.find((candidate) =>
    sameInstant(candidate.startUtc, input.slotStartUtc)
    && sameInstant(candidate.endUtc, input.slotEndUtc)
    && candidate.available
  );
  if (!slot) return { ok: false, reason: "slot_unavailable" };

  const holdId = `hld_${crypto.randomUUID()}`;
  const lockId = `blk_${crypto.randomUUID()}`;
  const expiresAtUtc = new Date(Date.parse(input.nowUtc) + HOLD_TTL_SECONDS * 1000).toISOString();

  const tx = await input.client.transaction("write");
  try {
    const repo = createBookingHoldWriteRepository(tx);
    const result = await repo.createHoldWithSlotLock({
      nowUtc: input.nowUtc,
      lock: {
        lockId,
        holdId,
        hostUserId: input.hostUserId,
        slotStartUtc: input.slotStartUtc,
        slotEndUtc: input.slotEndUtc,
        sourceCommunityId: input.sourceCommunityId,
        expiresAtUtc,
        createdAt: input.nowUtc,
      },
      hold: {
        holdId,
        hostUserId: input.hostUserId,
        bookerUserId: input.bookerUserId,
        slotStartUtc: input.slotStartUtc,
        slotEndUtc: input.slotEndUtc,
        priceCents: slot.priceCents,
        sourceCommunityId: input.sourceCommunityId,
        expiresAtUtc,
        createdAt: input.nowUtc,
      },
    });
    await tx.commit();
    if (!result.ok) return { ok: false, reason: "slot_locked" };
    return {
      ok: true,
      hold: toResponse({
        holdId,
        sourceCommunityId: input.sourceCommunityId,
        hostUserId: input.hostUserId,
        bookerUserId: input.bookerUserId,
        slotStartUtc: input.slotStartUtc,
        slotEndUtc: input.slotEndUtc,
        priceCents: slot.priceCents,
        expiresAtUtc,
      }),
    };
  } catch (error) {
    try {
      await tx.rollback();
    } catch (rollbackError) {
      console.error("[bookings] global hold transaction rollback failed", rollbackError);
    }
    throw error;
  } finally {
    tx.close();
  }
}
