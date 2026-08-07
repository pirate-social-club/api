import { describe, expect, test } from "bun:test"
import {
  buildHnsImportPublishPlan,
  compareHnsImportResource,
  nextHnsTreeBoundary,
} from "./hns-import-plan"

describe("buildHnsImportPublishPlan", () => {
  test("preserves opaque records and replaces only Pirate-controlled conflicts", () => {
    const synth = { type: "SYNTH4", address: "192.0.2.44" }
    const future = { type: "FUTURE9", payload: { opaque: ["keep", 9] } }
    const ownerTxt = { type: "TXT", txt: ["owner=", "alice"] }
    const plan = buildHnsImportPublishPlan({
      currentRecords: [
        synth,
        { type: "NS", ns: "old.example." },
        ownerTxt,
        { type: "TXT", txt: ["pirate-verification=old"] },
        { type: "DS", keyTag: 1, algorithm: 13, digestType: 2, digest: "aa" },
        future,
      ],
      nameservers: ["ns1.pirate.", "ns2.pirate."],
      challengeTxtValue: "pirate-verification=nvs_test",
      dsRecords: [
        `49194 13 2 ${"05".repeat(32)}`,
        `49194 13 4 ${"15".repeat(48)}`,
      ],
    })

    expect(plan.preserved_records).toEqual([synth, ownerTxt, future])
    expect(plan.preserved_unknown_record_types).toEqual(["FUTURE9", "SYNTH4"])
    expect(plan.removed_conflicts.map((record) => record.type)).toEqual(["NS", "TXT", "DS"])
    expect(plan.replacement_records).toEqual([
      synth,
      ownerTxt,
      future,
      { type: "NS", ns: "ns1.pirate." },
      { type: "NS", ns: "ns2.pirate." },
      { type: "TXT", txt: ["pirate-verification=nvs_test"] },
      { type: "DS", keyTag: 49194, algorithm: 13, digestType: 2, digest: "05".repeat(32) },
      { type: "DS", keyTag: 49194, algorithm: 13, digestType: 4, digest: "15".repeat(48) },
    ])
  })

  test("rejects the duplicated SHA-384 digest mistake before creating a session", () => {
    expect(() => buildHnsImportPublishPlan({
      currentRecords: [],
      nameservers: ["ns1.pirate.", "ns2.pirate."],
      challengeTxtValue: "pirate-verification=nvs_test",
      dsRecords: [
        `49194 13 2 ${"15".repeat(48)}`,
        `49194 13 4 ${"15".repeat(48)}`,
      ],
    })).toThrow("invalid DS digest")
  })

  test("requires one SHA-256 and one SHA-384 digest for the same key", () => {
    expect(() => buildHnsImportPublishPlan({
      currentRecords: [],
      nameservers: ["ns1.pirate.", "ns2.pirate."],
      challengeTxtValue: "pirate-verification=nvs_test",
      dsRecords: [
        `49194 13 2 ${"05".repeat(32)}`,
        `9999 13 4 ${"15".repeat(48)}`,
      ],
    })).toThrow("matching SHA-256 and SHA-384")
  })

  test("compares complete resources without treating record order as a change", () => {
    const first = { type: "TXT", txt: ["owner=", "alice"] }
    const second = { type: "SYNTH4", address: "192.0.2.44" }
    expect(compareHnsImportResource([first, second], [second, first])).toEqual({
      matches: true,
      missing: [],
      unexpected: [],
    })
    expect(compareHnsImportResource([first, second], [first])).toEqual({
      matches: false,
      missing: [second],
      unexpected: [],
    })
  })

  test("targets the next 36-block tree boundary after the mined observation", () => {
    expect(nextHnsTreeBoundary(341_443)).toBe(341_460)
    expect(nextHnsTreeBoundary(341_459)).toBe(341_460)
    expect(nextHnsTreeBoundary(341_460)).toBe(341_496)
  })
})
