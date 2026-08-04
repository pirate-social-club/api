import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  isAttestedGuaranteedMigration,
  parseCommunitySchemaGuarantees,
} from "./community-schema-guarantees"

const MANIFEST_PATH = resolve(import.meta.dir, "../../community-schema-requirements.json")

describe("parseCommunitySchemaGuarantees", () => {
  test("collects unconditional migrations", () => {
    const guarantees = parseCommunitySchemaGuarantees({
      unconditional: ["1096_community_karaoke_enabled.sql", "1124_community_job_checkpoints.sql"],
    })
    expect(guarantees.unconditional.size).toBe(2)
    expect(isAttestedGuaranteedMigration(guarantees, "1096_community_karaoke_enabled.sql")).toBe(true)
    expect(isAttestedGuaranteedMigration(guarantees, "1110_live_room_recording_enabled.sql")).toBe(false)
  })

  test("feature-gated migrations do NOT count as guaranteed", () => {
    // The fleet only has to satisfy a feature bundle when that feature is being
    // enabled, so runtime code must still tolerate absence.
    const guarantees = parseCommunitySchemaGuarantees({
      unconditional: [],
      features: { rewards: { migrations: ["1126_reward_qualification_outbox.sql"] } },
    })
    expect(guarantees.featureGated.has("1126_reward_qualification_outbox.sql")).toBe(true)
    expect(isAttestedGuaranteedMigration(guarantees, "1126_reward_qualification_outbox.sql")).toBe(false)
  })

  test("fails closed on a broken manifest rather than yielding an empty set", () => {
    // An empty guarantee set would make the guard lint MORE permissive exactly
    // when the manifest is unreadable, which is backwards.
    expect(() => parseCommunitySchemaGuarantees(null)).toThrow(/must be an object/u)
    expect(() => parseCommunitySchemaGuarantees({})).toThrow(/`unconditional` must be an array/u)
    expect(() => parseCommunitySchemaGuarantees({ unconditional: ["nope"] })).toThrow(/migration filename/u)
  })

  test("rejects a migration classified both unconditional and feature-gated", () => {
    expect(() =>
      parseCommunitySchemaGuarantees({
        unconditional: ["1126_reward_qualification_outbox.sql"],
        features: { rewards: { migrations: ["1126_reward_qualification_outbox.sql"] } },
      }),
    ).toThrow(/one classification only/u)
  })
})

describe("the checked-in manifest", () => {
  const guarantees = parseCommunitySchemaGuarantees(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")))

  test("the manifest era still starts at 1124", () => {
    // tests/community-schema-requirements.test.ts enforces that EVERY template
    // migration at or above the lowest classified one carries a class. So the
    // lowest entry is not a detail — it declares which era the manifest claims
    // to have an opinion about.
    //
    // The 2026-08-04 fleet audit is why it cannot drop below 1124 yet:
    //   1099-1107  checksum_mismatch on 75 shards
    //   1101-1108  objects missing on 12 shards
    //   1108       one partial application (DB_CMTY_0068, since repaired)
    //   1110-1113  objects missing on 75 shards
    //   1116, 1122 never fleet-rolled; snapshot-only propagation
    //   1123       ledger row missing on 90 shards
    // None of those has an honest class today: `unconditional` wedges the
    // blocking release gate, and `deferred` asserts the API does not read the
    // columns, which is false for the booking, live-room and karaoke paths.
    const lowest = [...guarantees.unconditional].sort()[0]
    expect(Number.parseInt(lowest, 10)).toBeGreaterThanOrEqual(1124)
  })

  test("does NOT declare the fleet's known-divergent cohorts", () => {
    // Declaring any of these would wedge the blocking release schema gate, and
    // would be the same max()-as-head lie that raising the scalar floor to 1115
    // would have been.
    for (const migration of [
      "1096_community_karaoke_enabled.sql",
      "1098_community_karaoke_scoring_policy.sql",
      "1101_booking_holds_and_bookings.sql",
      "1108_booking_settlement_review.sql",
      "1110_live_room_recording_enabled.sql",
      "1113_live_room_replay_locked_delivery.sql",
      "1123_karaoke_attempts.sql",
    ]) {
      expect(isAttestedGuaranteedMigration(guarantees, migration)).toBe(false)
    }
  })
})
