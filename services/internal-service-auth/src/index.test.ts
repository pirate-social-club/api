import { describe, expect, test } from "bun:test"
import { constantTimeTextEqual, hasValidBearerToken, readBearerToken } from "./index"

describe("internal service bearer authentication", () => {
  test("extracts only a Bearer token", () => {
    expect(readBearerToken(new Request("https://internal.test"))).toBe("")
    expect(readBearerToken(new Request("https://internal.test", {
      headers: { authorization: "Basic fixture" },
    }))).toBe("")
    expect(readBearerToken(new Request("https://internal.test", {
      headers: { authorization: "Bearer fixture-token" },
    }))).toBe("fixture-token")
  })

  test("rejects absent configuration and mismatched tokens", () => {
    const request = new Request("https://internal.test", {
      headers: { authorization: "Bearer fixture-token" },
    })
    expect(hasValidBearerToken(request, "")).toBe(false)
    expect(hasValidBearerToken(request, "different-token")).toBe(false)
    expect(hasValidBearerToken(request, "fixture-token")).toBe(true)
  })

  test("compares different-length text without accepting a prefix", () => {
    expect(constantTimeTextEqual("fixture", "fixture-extra")).toBe(false)
    expect(constantTimeTextEqual("fixture", "fixture")).toBe(true)
  })
})
