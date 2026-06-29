// Real-Postgres tests for global booking read projections. Runs only when
// BOOKINGS_REPO_TEST_ADMIN_URL is set and applies canonical core booking migrations.
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyCanonicalBookingMigrations } from "./test-migrations";
import {
  getGlobalBookingForParty,
  getGlobalBookingSettlementReview,
  listGlobalBookingsForUser,
  listPendingGlobalBookingSettlementReviews,
  type BookingReadSqlExecutor,
} from "./booking-read-service";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_read_service_test";

function urlFor(db?: string): string {
  const u = new URL(ADMIN_URL as string);
  if (db) u.pathname = `/${db}`;
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}

function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>);
}

function makeExecutor(conn: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }): BookingReadSqlExecutor {
  const toPg = (s: string) => s.replace(/\?(\d+)/gu, (_m, i: string) => `$${i}`);
  return {
    async execute(statement) {
      const st = typeof statement === "string" ? { sql: statement, args: [] as unknown[] } : statement;
      const rows = (await conn.unsafe(toPg(st.sql), st.args ?? [])) as Record<string, unknown>[];
      return { rows };
    },
  };
}

describe.skipIf(!RUN)("global booking read service (real Postgres)", () => {
  let repoDb: SQL;

  async function seedBooking(input: {
    bookingId: string;
    hostUserId?: string;
    bookerUserId?: string;
    sourceCommunityId?: string | null;
    status?: string;
    slotStartUtc?: string;
  }): Promise<void> {
    const hostUserId = input.hostUserId ?? `host_${input.bookingId}`;
    const bookerUserId = input.bookerUserId ?? `booker_${input.bookingId}`;
    await repoDb.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds, platform_fee_bps, created_at, updated_at)
      VALUES ($1, 'UTC', 5000, 1800, 500, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')
      ON CONFLICT (host_user_id) DO NOTHING`, [hostUserId]);
    await repoDb.unsafe(`INSERT INTO bookings.bookings (
        booking_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
        gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, refund_cents, status,
        funding_tx_ref, payout_tx_ref, refund_tx_ref, funding_wallet_address, host_payout_wallet_address,
        live_room_id, source_community_id, confirmed_at, completed_at, settled_at, cancelled_at, created_at, updated_at
      ) VALUES (
        $1, NULL, $2, $3, $4::timestamptz, ($4::timestamptz + interval '30 minutes'),
        5000, 500, 250, 4750, NULL, $5,
        $7, NULL, NULL, '0xbuyer', '0xhost',
        NULL, $6, '2026-07-01T09:50:00Z', NULL, NULL, NULL, '2026-07-01T09:50:00Z', '2026-07-01T09:50:00Z'
      )`, [
      input.bookingId,
      hostUserId,
      bookerUserId,
      input.slotStartUtc ?? "2026-07-01T10:00:00Z",
      input.status ?? "confirmed",
      input.sourceCommunityId === undefined ? "community_read_a" : input.sourceCommunityId,
      `0xfund_${input.bookingId}`,
    ]);
  }

  async function markPendingReview(bookingId: string, updatedAt: string): Promise<void> {
    await repoDb.unsafe(`UPDATE bookings.bookings
      SET status = 'disputed',
          settlement_review_status = 'pending',
          settlement_review_reason = 'attendance_ambiguous',
          settlement_review_opened_at = $2::timestamptz,
          settlement_review_version = settlement_review_version + 1,
          updated_at = $2::timestamptz
      WHERE booking_id = $1`, [bookingId, updatedAt]);
  }

  beforeAll(async () => {
    const root = connect();
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await root.end();

    const db = connect(TEST_DB);
    for (const r of ["control_plane_api_rw", "control_plane_api_ro"]) {
      await db.unsafe(`DROP ROLE IF EXISTS ${r}`);
      await db.unsafe(`CREATE ROLE ${r} NOLOGIN`);
    }
    await db.unsafe("CREATE EXTENSION IF NOT EXISTS btree_gist");
    await applyCanonicalBookingMigrations(db);
    await db.end();

    repoDb = connect(TEST_DB);
  });

  afterAll(async () => {
    if (repoDb) await repoDb.end();
    const root = connect();
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
    for (const r of ["control_plane_api_rw", "control_plane_api_ro"]) {
      await root.unsafe(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
    }
    await root.end();
  });

  test("getGlobalBookingForParty returns party-authorized booking views only", async () => {
    await seedBooking({ bookingId: "bkg_read_get", hostUserId: "host_read_get", bookerUserId: "booker_read_get" });

    const asHost = await getGlobalBookingForParty({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_read_get",
      actorUserId: "host_read_get",
    });
    expect(asHost?.viewer_role).toBe("host");
    expect(asHost?.community_id).toBe("community_read_a");
    expect(asHost?.funding_tx_ref).toBe("0xfund_bkg_read_get");

    const asBooker = await getGlobalBookingForParty({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_read_get",
      actorUserId: "booker_read_get",
    });
    expect(asBooker?.viewer_role).toBe("booker");

    expect(await getGlobalBookingForParty({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_read_get",
      actorUserId: "stranger",
    })).toBeNull();
  });

  test("listGlobalBookingsForUser filters role, source community, and status with deterministic ordering", async () => {
    await seedBooking({
      bookingId: "bkg_read_list_new",
      hostUserId: "host_read_list",
      bookerUserId: "booker_read_list_a",
      sourceCommunityId: "community_read_a",
      status: "confirmed",
      slotStartUtc: "2026-07-02T10:00:00Z",
    });
    await seedBooking({
      bookingId: "bkg_read_list_old",
      hostUserId: "host_read_list",
      bookerUserId: "booker_read_list_b",
      sourceCommunityId: "community_read_a",
      status: "live",
      slotStartUtc: "2026-07-01T10:00:00Z",
    });
    await seedBooking({
      bookingId: "bkg_read_list_other_community",
      hostUserId: "host_read_list",
      bookerUserId: "booker_read_list_c",
      sourceCommunityId: "community_read_b",
      status: "confirmed",
      slotStartUtc: "2026-07-03T10:00:00Z",
    });

    const allForCommunity = await listGlobalBookingsForUser({
      executor: makeExecutor(repoDb),
      actorUserId: "host_read_list",
      role: "host",
      sourceCommunityId: "community_read_a",
    });
    expect(allForCommunity.map((booking) => booking.booking_id)).toEqual(["bkg_read_list_new", "bkg_read_list_old"]);

    const confirmedOnly = await listGlobalBookingsForUser({
      executor: makeExecutor(repoDb),
      actorUserId: "host_read_list",
      role: "host",
      sourceCommunityId: "community_read_a",
      statuses: ["confirmed"],
    });
    expect(confirmedOnly.map((booking) => booking.booking_id)).toEqual(["bkg_read_list_new"]);

    const asBooker = await listGlobalBookingsForUser({
      executor: makeExecutor(repoDb),
      actorUserId: "booker_read_list_a",
      role: "booker",
      sourceCommunityId: "community_read_a",
    });
    expect(asBooker.map((booking) => booking.booking_id)).toEqual(["bkg_read_list_new"]);
  });

  test("lists and gets pending settlement reviews with source filter and cursor pagination", async () => {
    await seedBooking({
      bookingId: "bkg_read_review_a",
      hostUserId: "host_read_review",
      bookerUserId: "booker_read_review_a",
      sourceCommunityId: "community_review_a",
      status: "live",
      slotStartUtc: "2026-07-04T10:00:00Z",
    });
    await seedBooking({
      bookingId: "bkg_read_review_b",
      hostUserId: "host_read_review",
      bookerUserId: "booker_read_review_b",
      sourceCommunityId: "community_review_a",
      status: "live",
      slotStartUtc: "2026-07-05T10:00:00Z",
    });
    await seedBooking({
      bookingId: "bkg_read_review_other",
      hostUserId: "host_read_review",
      bookerUserId: "booker_read_review_c",
      sourceCommunityId: "community_review_b",
      status: "live",
      slotStartUtc: "2026-07-06T10:00:00Z",
    });
    await markPendingReview("bkg_read_review_a", "2026-07-04T11:00:00Z");
    await markPendingReview("bkg_read_review_b", "2026-07-04T11:05:00Z");
    await markPendingReview("bkg_read_review_other", "2026-07-04T11:02:00Z");

    const firstPage = await listPendingGlobalBookingSettlementReviews({
      executor: makeExecutor(repoDb),
      sourceCommunityId: "community_review_a",
      limit: 1,
    });
    expect(firstPage.data.map((review) => review.booking_id)).toEqual(["bkg_read_review_a"]);
    expect(firstPage.has_more).toBe(true);
    expect(typeof firstPage.next_cursor).toBe("string");

    const secondPage = await listPendingGlobalBookingSettlementReviews({
      executor: makeExecutor(repoDb),
      sourceCommunityId: "community_review_a",
      limit: 1,
      cursor: firstPage.next_cursor,
    });
    expect(secondPage.data.map((review) => review.booking_id)).toEqual(["bkg_read_review_b"]);
    expect(secondPage.has_more).toBe(false);
    expect(secondPage.next_cursor).toBeNull();

    const detail = await getGlobalBookingSettlementReview({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_read_review_a",
    });
    expect(detail).toMatchObject({
      object: "booking_settlement_review",
      booking_id: "bkg_read_review_a",
      community_id: "community_review_a",
      booking_status: "disputed",
      review_status: "pending",
      review_reason: "attendance_ambiguous",
      review_resolution: null,
      review_version: 1,
    });
  });
});
