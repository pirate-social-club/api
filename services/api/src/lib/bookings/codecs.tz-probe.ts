// Spawned by codecs.test.ts under a non-UTC TZ to prove the timestamp codec is locale-independent:
// a tz-less string is rejected (never silently shifted), and Z/offset inputs resolve to the same
// absolute instant regardless of process timezone. Exits non-zero on any mismatch.
import { isoUtcFromRow } from "./codecs";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`tz-probe FAIL (TZ=${process.env.TZ ?? "(unset)"}): ${msg}`);
    process.exit(1);
  }
}

let rejected = false;
try { isoUtcFromRow("2026-07-01 09:00:00"); } catch { rejected = true; }
assert(rejected, "timezone-less timestamp must be rejected");

assert(isoUtcFromRow("2026-07-01T09:00:00Z") === "2026-07-01T09:00:00.000Z", "Z input must be locale-independent");
assert(isoUtcFromRow(new Date("2026-07-01T09:00:00Z")) === "2026-07-01T09:00:00.000Z", "Date input must be locale-independent");
assert(isoUtcFromRow("2026-07-01 09:00:00+00") === "2026-07-01T09:00:00.000Z", "+00 offset must normalize to ...Z");
assert(isoUtcFromRow("2026-07-01T09:00:00+02:00") === "2026-07-01T07:00:00.000Z", "+02:00 must resolve to 07:00Z");

console.log(`tz-probe ok (TZ=${process.env.TZ ?? "(unset)"})`);
