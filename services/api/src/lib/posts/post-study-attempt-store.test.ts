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

  test("treats an unversioned legacy id specifically as generation v2", () => {
    expect(parseFillBlankExerciseIdentity("stu:unit_1:fill_blank:en")).toEqual({
      fingerprint: null,
      language: "en",
      unitId: "unit_1",
      version: 2,
    })
  })

  test("rejects truncated fingerprints instead of weakening identity matching", () => {
    expect(parseFillBlankExerciseIdentity("stu:unit_1:fill_blank:v3:deadbeef:en")).toBeNull()
  })
})
