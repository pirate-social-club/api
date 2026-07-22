import { describe, expect, test } from "bun:test"
import { parseCommentLimit } from "./comment-read-service"
import { parseProfileActivityLimit } from "../profile/profile-activity-read-service"

describe("parseCommentLimit", () => {
  // Regression: an absent `limit` query param arrives as null/"" and Number("")
  // is 0 — a finite value — so the default branch was unreachable and every
  // unparameterized comment list collapsed to a single item.
  test("falls back to the default when the limit is absent or blank", () => {
    expect(parseCommentLimit(undefined)).toBe(25)
    expect(parseCommentLimit(null)).toBe(25)
    expect(parseCommentLimit("")).toBe(25)
    expect(parseCommentLimit("   ")).toBe(25)
  })

  test("falls back to the default when the limit is not a number", () => {
    expect(parseCommentLimit("abc")).toBe(25)
  })

  test("honours and clamps explicit limits", () => {
    expect(parseCommentLimit("10")).toBe(10)
    expect(parseCommentLimit("0")).toBe(1)
    expect(parseCommentLimit("-5")).toBe(1)
    expect(parseCommentLimit("500")).toBe(100)
  })
})

describe("parseProfileActivityLimit", () => {
  test("falls back to the default when the limit is absent or blank", () => {
    expect(parseProfileActivityLimit(undefined)).toBe(20)
    expect(parseProfileActivityLimit(null)).toBe(20)
    expect(parseProfileActivityLimit("")).toBe(20)
    expect(parseProfileActivityLimit("   ")).toBe(20)
  })

  test("honours and clamps explicit limits", () => {
    expect(parseProfileActivityLimit("10")).toBe(10)
    expect(parseProfileActivityLimit("0")).toBe(1)
    expect(parseProfileActivityLimit("500")).toBe(50)
  })
})
