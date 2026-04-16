import { describe, expect, test } from "bun:test"
import { normalizeRootLabel, mintSpacesChallenge } from "../src/lib/verification/spaces-verifier"
import { getHnsVerifierBaseUrl, isHnsVerifierConfigured } from "../src/lib/verification/hns-verifier"

describe("normalizeRootLabel", () => {
  test("strips leading @ and lowercases", () => {
    expect(normalizeRootLabel("@MySpace")).toBe("myspace")
  })

  test("lowercases without @", () => {
    expect(normalizeRootLabel("MySpace")).toBe("myspace")
  })

  test("trims whitespace", () => {
    expect(normalizeRootLabel("  @MySpace  ")).toBe("myspace")
  })

  test("handles empty after @", () => {
    expect(normalizeRootLabel("@")).toBe("")
  })

  test("handles already-normalized input", () => {
    expect(normalizeRootLabel("myspace")).toBe("myspace")
  })
})

describe("mintSpacesChallenge", () => {
  const env = {
    SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
    SPACES_VERIFIER_CHALLENGE_DOMAIN: "pirate.sc",
  } as any

  test("produces a well-formed challenge payload", async () => {
    const result = await mintSpacesChallenge(env, "myspace", "test-pubkey", "nvs_123")
    const payload = result.challengePayload

    expect(payload.kind).toBe("schnorr_sign")
    expect(payload.domain).toBe("pirate.sc")
    expect(payload.root_label).toBe("myspace")
    expect(payload.root_pubkey).toBe("test-pubkey")
    expect(payload.nonce).toContain("pirate-space-verify=nvs_123:")
    expect(payload.message).toContain("pirate.space.verify")
    expect(payload.message).toContain("root=@myspace")
    expect(payload.message).toContain("root_pubkey=test-pubkey")
    expect(typeof payload.digest).toBe("string")
    expect(payload.digest.length).toBe(64)
  })

  test("challenge expiry is 10 minutes after issue", async () => {
    const result = await mintSpacesChallenge(env, "myspace", "test-pubkey", "nvs_123")
    const issuedAt = new Date(result.challengePayload.issued_at).getTime()
    const expiresAt = new Date(result.challengeExpiresAt).getTime()
    expect(expiresAt - issuedAt).toBe(10 * 60 * 1000)
  })

  test("normalizes root label in the payload", async () => {
    const result = await mintSpacesChallenge(env, "@MySpace", "test-pubkey", "nvs_123")
    expect(result.challengePayload.root_label).toBe("myspace")
    expect(result.challengePayload.message).toContain("root=@myspace")
  })

  test("uses default domain when env var is empty", async () => {
    const emptyEnv = { SPACES_VERIFIER_CHALLENGE_DOMAIN: "" } as any
    const result = await mintSpacesChallenge(emptyEnv, "myspace", "test-pubkey", "nvs_123")
    expect(result.challengePayload.domain).toBe("pirate.sc")
  })

  test("uses custom domain when configured", async () => {
    const customEnv = { SPACES_VERIFIER_CHALLENGE_DOMAIN: "custom.sc" } as any
    const result = await mintSpacesChallenge(customEnv, "myspace", "test-pubkey", "nvs_123")
    expect(result.challengePayload.domain).toBe("custom.sc")
    expect(result.challengePayload.message).toContain("domain=custom.sc")
  })

  test("throws on empty root pubkey", async () => {
    expect(mintSpacesChallenge(env, "myspace", "", "nvs_123")).rejects.toThrow()
  })

  test("throws on whitespace-only root pubkey", async () => {
    expect(mintSpacesChallenge(env, "myspace", "   ", "nvs_123")).rejects.toThrow()
  })

  test("digest is a deterministic SHA-256 of the message", async () => {
    const encoder = new TextEncoder()
    const result = await mintSpacesChallenge(env, "myspace", "test-pubkey", "nvs_123")
    const expectedDigest = await crypto.subtle.digest("SHA-256", encoder.encode(result.challengePayload.message))
    const expectedHex = Array.from(new Uint8Array(expectedDigest), (b) => b.toString(16).padStart(2, "0")).join("")
    expect(result.challengePayload.digest).toBe(expectedHex)
  })
})

describe("getHnsVerifierBaseUrl", () => {
  test("returns null when not configured", () => {
    expect(getHnsVerifierBaseUrl({} as any)).toBeNull()
  })

  test("returns null when empty string", () => {
    expect(getHnsVerifierBaseUrl({ HNS_VERIFIER_BASE_URL: "" } as any)).toBeNull()
  })

  test("returns trimmed URL", () => {
    expect(getHnsVerifierBaseUrl({ HNS_VERIFIER_BASE_URL: "  http://hns.test  " } as any)).toBe("http://hns.test")
  })

  test("strips trailing slashes", () => {
    expect(getHnsVerifierBaseUrl({ HNS_VERIFIER_BASE_URL: "http://hns.test///" } as any)).toBe("http://hns.test")
  })

  test("rejects URL ending with /inspect", () => {
    expect(() => getHnsVerifierBaseUrl({ HNS_VERIFIER_BASE_URL: "http://hns.test/inspect" } as any)).toThrow()
  })

  test("rejects URL ending with /publish-txt", () => {
    expect(() => getHnsVerifierBaseUrl({ HNS_VERIFIER_BASE_URL: "http://hns.test/publish-txt" } as any)).toThrow()
  })

  test("rejects URL ending with /verify-txt", () => {
    expect(() => getHnsVerifierBaseUrl({ HNS_VERIFIER_BASE_URL: "http://hns.test/verify-txt" } as any)).toThrow()
  })
})

describe("isHnsVerifierConfigured", () => {
  test("returns false when not configured", () => {
    expect(isHnsVerifierConfigured({} as any)).toBe(false)
  })

  test("returns true when configured", () => {
    expect(isHnsVerifierConfigured({ HNS_VERIFIER_BASE_URL: "http://hns.test" } as any)).toBe(true)
  })
})
