import { describe, expect, test } from "bun:test"
import {
  issueKaraokeGatewayToken,
  verifyKaraokeGatewayToken,
  type KaraokeGatewayClaims,
} from "../../../src/lib/karaoke/gateway-token"

const SECRET = "test-karaoke-gateway-signing-key-000000000000000"
const NOW = 1_800_000_000

function claims(overrides: Partial<KaraokeGatewayClaims> = {}): KaraokeGatewayClaims {
  return {
    attemptId: "attempt-1",
    communityId: "community-1",
    expiresAt: NOW + 60,
    issuedAt: NOW,
    nonce: "nonce-1",
    postId: "post-1",
    protocolVersion: 1,
    sessionId: "session-1",
    subject: "user-1",
    tokenVersion: 1,
    ...overrides,
  }
}

describe("karaoke gateway tokens", () => {
  test("signs deterministically and verifies valid claims", async () => {
    const first = await issueKaraokeGatewayToken({ claims: claims(), secret: SECRET })
    const second = await issueKaraokeGatewayToken({ claims: claims(), secret: SECRET })
    expect(first).toBe(second)
    expect(await verifyKaraokeGatewayToken({ nowSeconds: NOW, secret: SECRET, token: first }))
      .toEqual({ claims: claims() })
  })

  test("rejects tampering and the wrong secret", async () => {
    const token = await issueKaraokeGatewayToken({ claims: claims(), secret: SECRET })
    const [header, payload, signature] = token.split(".")
    expect((await verifyKaraokeGatewayToken({
      nowSeconds: NOW,
      secret: SECRET,
      token: `${header}.${payload}a.${signature}`,
    })).error).toBe("invalid_token")
    expect((await verifyKaraokeGatewayToken({
      nowSeconds: NOW,
      secret: "another-karaoke-gateway-signing-key-000000000000",
      token,
    })).error).toBe("invalid_token")
  })

  test("enforces expiry, future skew, and maximum lifetime", async () => {
    const expired = await issueKaraokeGatewayToken({ claims: claims({ expiresAt: NOW }), secret: SECRET })
    expect((await verifyKaraokeGatewayToken({ nowSeconds: NOW, secret: SECRET, token: expired })).error)
      .toBe("token_expired")

    const future = await issueKaraokeGatewayToken({ claims: claims({ issuedAt: NOW + 31, expiresAt: NOW + 60 }), secret: SECRET })
    expect((await verifyKaraokeGatewayToken({ nowSeconds: NOW, secret: SECRET, token: future })).error)
      .toBe("token_issued_in_future")

    const long = await issueKaraokeGatewayToken({ claims: claims({ expiresAt: NOW + 61 }), secret: SECRET })
    expect((await verifyKaraokeGatewayToken({ nowSeconds: NOW, secret: SECRET, token: long })).error)
      .toBe("token_lifetime_exceeded")
  })

  test("round-trips UTF-8 claims without weakening validation", async () => {
    const expected = claims({ communityId: "音楽", subject: "使用者" })
    const token = await issueKaraokeGatewayToken({ claims: expected, secret: SECRET })
    expect((await verifyKaraokeGatewayToken({ nowSeconds: NOW, secret: SECRET, token })).claims)
      .toEqual(expected)
  })
})
