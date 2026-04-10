import { describe, expect, test } from "bun:test"
import { decodeJwtTimes } from "./session.js"

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

describe("decodeJwtTimes", () => {
  test("extracts iat and exp timestamps from a JWT payload", () => {
    const header = encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }))
    const payload = encodeBase64Url(JSON.stringify({ iat: 1_700_000_000, exp: 1_700_003_600 }))
    const token = `${header}.${payload}.signature`

    expect(decodeJwtTimes(token)).toEqual({
      issuedAt: "2023-11-14T22:13:20.000Z",
      expiresAt: "2023-11-14T23:13:20.000Z",
    })
  })

  test("returns null timestamps for malformed tokens", () => {
    expect(decodeJwtTimes("not-a-jwt")).toEqual({
      issuedAt: null,
      expiresAt: null,
    })
  })
})
