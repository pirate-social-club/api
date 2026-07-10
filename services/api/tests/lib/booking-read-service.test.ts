import { describe, expect, test } from "bun:test";

import { enrichGlobalBookingCounterparties, type BookingView } from "../../src/lib/bookings/booking-read-service";

function booking(patch: Partial<BookingView> = {}): BookingView {
  return {
    object: "booking",
    booking_id: "bkg_test",
    community_id: "",
    host_user_id: "usr_host",
    booker_user_id: "usr_booker",
    slot_start_utc: "2026-07-10T10:00:00.000Z",
    slot_end_utc: "2026-07-10T10:30:00.000Z",
    gross_cents: 5000,
    platform_fee_cents: 500,
    host_payout_cents: 4500,
    refund_cents: null,
    status: "confirmed",
    outcome: null,
    settlement_status: "pending",
    funding_tx_ref: null,
    payout_tx_ref: null,
    refund_tx_ref: null,
    live_room_id: null,
    confirmed_at: null,
    completed_at: null,
    settled_at: null,
    cancelled_at: null,
    created_at: "2026-07-10T09:00:00.000Z",
    updated_at: "2026-07-10T09:00:00.000Z",
    viewer_role: "booker",
    counterparty: { user_id: "usr_host", display_name: null, avatar_ref: null },
    ...patch,
  };
}

describe("enrichGlobalBookingCounterparties", () => {
  test("batch-resolves only the other party's current public profile", async () => {
    const requested: string[][] = [];
    const result = await enrichGlobalBookingCounterparties({
      bookings: [booking(), booking({ booking_id: "bkg_second" })],
      profileRepository: {
        listProfilesByUserIds: async (userIds: string[]) => {
          requested.push(userIds);
          return new Map([["usr_host", { display_name: "Host Name", avatar_ref: "avatar-ref" } as never]]);
        },
      } as never,
    });

    expect(requested).toEqual([["usr_host"]]);
    expect(result.map((item) => item.counterparty)).toEqual([
      { user_id: "usr_host", display_name: "Host Name", avatar_ref: "avatar-ref" },
      { user_id: "usr_host", display_name: "Host Name", avatar_ref: "avatar-ref" },
    ]);
  });

  test("falls back to individual profile reads when batch lookup is unavailable", async () => {
    const requested: string[] = [];
    const result = await enrichGlobalBookingCounterparties({
      bookings: [
        booking(),
        booking({
          booking_id: "bkg_host_view",
          viewer_role: "host",
          counterparty: { user_id: "usr_booker", display_name: null, avatar_ref: null },
        }),
      ],
      profileRepository: {
        getProfileByUserId: async (userId: string) => {
          requested.push(userId);
          return { display_name: userId === "usr_host" ? "Host Name" : "Booker Name", avatar_ref: null } as never;
        },
      } as never,
    });

    expect(requested).toEqual(["usr_host", "usr_booker"]);
    expect(result.map((item) => item.counterparty.display_name)).toEqual(["Host Name", "Booker Name"]);
  });
});
