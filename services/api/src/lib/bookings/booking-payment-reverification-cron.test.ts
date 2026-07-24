import { describe, expect, test } from "bun:test";
import type { Env } from "../../env";
import type { UserRepository } from "../auth/repositories";
import {
  emptyBookingPaymentReverificationSummary,
  isBookingPaymentReverificationCronEnabled,
  sweepClaimedBookingPaymentIntents,
} from "./booking-payment-reverification-cron";

describe("booking payment re-verification cron", () => {
  test("uses an explicit gate independent of settlement execution", () => {
    expect(isBookingPaymentReverificationCronEnabled({} as Env)).toBe(false);
    expect(isBookingPaymentReverificationCronEnabled({
      BOOKINGS_SETTLEMENT_CRON_ENABLED: "true",
    } as Env)).toBe(false);
    expect(isBookingPaymentReverificationCronEnabled({
      BOOKINGS_PAYMENT_REVERIFICATION_CRON_ENABLED: " TRUE ",
    } as Env)).toBe(true);
  });

  test("does not enumerate payment intents while disabled", async () => {
    let queried = false;
    const summary = await sweepClaimedBookingPaymentIntents({
      env: {} as Env,
      client: {
        async execute() {
          queried = true;
          throw new Error("disabled sweep must not query");
        },
      },
      userRepository: {} as UserRepository,
    });
    expect(queried).toBe(false);
    expect(summary).toEqual(emptyBookingPaymentReverificationSummary(false));
  });
});
