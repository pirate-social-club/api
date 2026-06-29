import type { Env } from "../../env";
import { createBookingLifecycleWriteRepository, type BookingLifecycleSqlExecutor } from "./booking-lifecycle-repository";
import type { AttendanceParty, Booking } from "./types";

const SESSION_START_LEAD_MS = 5 * 60_000;
const ATTACHABLE_STATES = new Set<string>(["confirmed", "live"]);

interface BookingLifecycleSnapshot {
  booking_id: string;
  status: string;
  refund_cents: number;
  refund_tx_ref: string | null;
  payout_tx_ref: string | null;
}

type AgoraBlock = {
  provider: "agora";
  channel: string;
  uid: number;
  token: string;
  expires_at: string;
};

type AgoraBuilder = (input: { env: Env; channel: string; uid: number }) => AgoraBlock;
let agoraBuilderForTests: AgoraBuilder | null = null;

export function setGlobalBookingAgoraBuilderForTests(builder: AgoraBuilder | null): void {
  agoraBuilderForTests = builder;
}

async function buildAgoraBlock(input: { env: Env; channel: string; uid: number }): Promise<AgoraBlock> {
  if (agoraBuilderForTests) return agoraBuilderForTests(input);
  const mod = await import("../communities/live-rooms/runtime");
  return mod.buildAgoraBlock(input);
}

function randomAgoraUid(): number {
  const v = new Uint32Array(1);
  crypto.getRandomValues(v);
  return v[0];
}

function deriveBookingChannel(bookingId: string): string {
  return `pirate-booking-${bookingId}`;
}

function epochMs(iso: string): number {
  return Date.parse(iso);
}

function snapshot(booking: Booking): BookingLifecycleSnapshot {
  return {
    booking_id: booking.bookingId,
    status: booking.status,
    refund_cents: booking.refundCents ?? 0,
    refund_tx_ref: booking.refundTxRef,
    payout_tx_ref: booking.payoutTxRef,
  };
}

function actorParty(booking: Booking, actorUserId: string): AttendanceParty | null {
  if (booking.hostUserId === actorUserId) return "host";
  if (booking.bookerUserId === actorUserId) return "booker";
  return null;
}

export type GlobalLifecycleResult =
  | { ok: false; reason: "not_found" | "illegal_transition" | "outside_start_window" }
  | { ok: true; already: boolean; booking: BookingLifecycleSnapshot };

export async function startGlobalBookingSession(input: {
  executor: BookingLifecycleSqlExecutor;
  bookingId: string;
  actorUserId: string;
  nowUtc: string;
  system?: boolean;
}): Promise<GlobalLifecycleResult> {
  const repo = createBookingLifecycleWriteRepository(input.executor);
  const booking = await repo.getBooking(input.bookingId);
  if (!booking || !actorParty(booking, input.actorUserId)) return { ok: false, reason: "not_found" };
  if (booking.status === "live") return { ok: true, already: true, booking: snapshot(booking) };
  if (!input.system && (epochMs(input.nowUtc) < epochMs(booking.slotStartUtc) - SESSION_START_LEAD_MS || epochMs(input.nowUtc) >= epochMs(booking.slotEndUtc))) {
    return { ok: false, reason: "outside_start_window" };
  }
  if (booking.status !== "confirmed") return { ok: false, reason: "illegal_transition" };
  const started = await repo.startBookingSession(input.bookingId, input.nowUtc);
  if (!started) return { ok: false, reason: "illegal_transition" };
  return { ok: true, already: false, booking: snapshot(started) };
}

export type AttachGlobalBookingSessionResult =
  | { ok: false; reason: "not_found" | "not_attachable" }
  | { ok: true; party: AttendanceParty; sessionId: string; channel: string; agora: AgoraBlock };

export async function attachGlobalBookingSession(input: {
  env: Env;
  executor: BookingLifecycleSqlExecutor;
  bookingId: string;
  actorUserId: string;
  nowUtc: string;
}): Promise<AttachGlobalBookingSessionResult> {
  const repo = createBookingLifecycleWriteRepository(input.executor);
  const booking = await repo.getBooking(input.bookingId);
  const party = booking ? actorParty(booking, input.actorUserId) : null;
  if (!booking || !party) return { ok: false, reason: "not_found" };
  if (!ATTACHABLE_STATES.has(booking.status)) return { ok: false, reason: "not_attachable" };

  const channel = deriveBookingChannel(input.bookingId);
  const uid = randomAgoraUid();
  const agora = await buildAgoraBlock({ env: input.env, channel, uid });
  const sessionId = `bas_${crypto.randomUUID()}`;
  const session = await repo.attachAttendanceSession({
    sessionId,
    bookingId: input.bookingId,
    party,
    userId: input.actorUserId,
    agoraUid: uid,
    attachedAt: input.nowUtc,
  });
  if (!session) return { ok: false, reason: "not_attachable" };
  await repo.setBookingLiveRoomIfUnset(input.bookingId, channel, input.nowUtc);
  return { ok: true, party, sessionId, channel, agora };
}

export type GlobalHeartbeatResult = { ok: false; reason: "not_found" } | { ok: true };

export async function heartbeatGlobalBookingSession(input: {
  executor: BookingLifecycleSqlExecutor;
  bookingId: string;
  actorUserId: string;
  sessionId: string;
  nowUtc: string;
}): Promise<GlobalHeartbeatResult> {
  const result = await createBookingLifecycleWriteRepository(input.executor).heartbeatAttendanceSession({
    heartbeatId: `bah_${crypto.randomUUID()}`,
    sessionId: input.sessionId,
    bookingId: input.bookingId,
    userId: input.actorUserId,
    seenAt: input.nowUtc,
  });
  return result.ok ? { ok: true } : { ok: false, reason: "not_found" };
}
