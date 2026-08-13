import { describe, expect, test } from "bun:test"
import { parseFillBlankExerciseIdentity } from "./post-study-attempt-store"

describe("fill-blank exercise identity", () => {
  test("parses the version and full source fingerprint", () => {
    const fingerprint = "a".repeat(64)
    expect(parseFillBlankExerciseIdentity(`stu:unit_1:fill_blank:v3:${fingerprint}:en-US`)).toEqual({
      fingerprint,
      language: "en-US",
      unitId: "unit_1",
      version: 3,
    })
  })

  test("rejects an expired unversioned v2 id", () => {
    expect(parseFillBlankExerciseIdentity("stu:unit_1:fill_blank:en")).toBeNull()
  })

  test("rejects truncated fingerprints instead of weakening identity matching", () => {
    expect(parseFillBlankExerciseIdentity("stu:unit_1:fill_blank:v3:deadbeef:en")).toBeNull()
  })
})
