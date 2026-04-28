import { describe, expect, test } from "bun:test"
import {
  inspectSpacesNamespace,
  normalizeRootLabel,
  mintSpacesChallenge,
  SPACES_FABRIC_PUBLISH_CHALLENGE_TTL_MS,
  verifySpacesFabricPublish,
} from "../src/lib/verification/spaces-verifier"
import { getHnsVerifierBaseUrl, inspectHnsRoot, isHnsVerifierConfigured } from "../src/lib/verification/hns-verifier"
import { withMockedFetch } from "./helpers"

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

  test("canonicalizes IDNA emoji labels", () => {
    expect(normalizeRootLabel("@☠")).toBe("xn--h4h")
    expect(normalizeRootLabel("@☠️")).toBe("xn--h4h")
    expect(normalizeRootLabel("@\u{1F1F5}\u{1F1F8}")).toBe("xn--t77hga")
  })

  test("keeps canonical literal ASCII xn labels", () => {
    expect(normalizeRootLabel("@xn--t77hga")).toBe("xn--t77hga")
  })

  test("does not canonicalize fake literal ASCII xn labels", () => {
    expect(normalizeRootLabel("@xn--238746723487")).toBe("xn--238746723487")
  })

  test("canonicalizes NFKC-equivalent labels before IDNA", () => {
    expect(normalizeRootLabel("@ＡＢＣ")).toBe("abc")
    expect(normalizeRootLabel("@e\u0301")).toBe("xn--9ca")
    expect(normalizeRootLabel("@é")).toBe("xn--9ca")
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

    expect(payload.kind).toBe("fabric_txt_publish")
    expect(payload.domain).toBe("pirate.sc")
    expect(payload.root_label).toBe("myspace")
    expect(payload.root_pubkey).toBe("test-pubkey")
    expect(payload.nonce).toContain("nvs_123:")
    expect(payload.txt_key).toBe("pirate-verify")
    expect(payload.txt_value).toContain("pirate-space-verify=nvs_123:")
    expect(payload.web_url).toBe("https://pirate.sc/c/@myspace")
    expect(payload.freedom_url).toBe("https://pirate.sc/c/@myspace")
  })

  test("challenge expiry uses the Spaces Fabric publish TTL", async () => {
    const result = await mintSpacesChallenge(env, "myspace", "test-pubkey", "nvs_123")
    const issuedAt = new Date(result.challengePayload.issued_at).getTime()
    const expiresAt = new Date(result.challengeExpiresAt).getTime()
    expect(expiresAt - issuedAt).toBe(SPACES_FABRIC_PUBLISH_CHALLENGE_TTL_MS)
  })

  test("normalizes root label in the payload", async () => {
    const result = await mintSpacesChallenge(env, "@MySpace", "test-pubkey", "nvs_123")
    expect(result.challengePayload.root_label).toBe("myspace")
    expect(result.challengePayload.web_url).toBe("https://pirate.sc/c/@myspace")
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
    expect(result.challengePayload.web_url).toBe("https://custom.sc/c/@myspace")
  })

  test("throws on empty root pubkey", async () => {
    expect(mintSpacesChallenge(env, "myspace", "", "nvs_123")).rejects.toThrow()
  })

  test("throws on whitespace-only root pubkey", async () => {
    expect(mintSpacesChallenge(env, "myspace", "   ", "nvs_123")).rejects.toThrow()
  })

  test("txt value contains the session-bound nonce", async () => {
    const result = await mintSpacesChallenge(env, "myspace", "test-pubkey", "nvs_123")
    expect(result.challengePayload.txt_value).toBe(`pirate-space-verify=${result.challengePayload.nonce}`)
  })
})

describe("inspectSpacesNamespace", () => {
  const env = {
    SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
  } as any

  test("canonicalizes emoji labels before calling the verifier", async () => {
    let capturedUrl: string | null = null
    await withMockedFetch(() => (async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString()
      return new Response(JSON.stringify({
        root_exists: true,
        root_key_proof_verified: true,
        root_pubkey: "spaces-root-pubkey",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch, async () => {
      const result = await inspectSpacesNamespace(env, "@☠️")
      expect(result.rootExists).toBe(true)
      expect(capturedUrl).toBe("http://spaces-verifier.test/inspect?root_label=xn--h4h")
    })
  })

  test("rejects unsupported raw Unicode labels before calling the verifier", async () => {
    let called = false
    await withMockedFetch((originalFetch) => ((...args: Parameters<typeof fetch>) => {
      called = true
      return originalFetch(...args)
    }) as typeof fetch, async () => {
      try {
        await inspectSpacesNamespace(env, "@🏴‍☠️")
        throw new Error("expected inspectSpacesNamespace to reject")
      } catch (error) {
        expect(error).toMatchObject({
          status: 400,
          code: "bad_request",
        })
      }
      expect(called).toBe(false)
    })
  })

  test("rejects fake literal ASCII xn labels before calling the verifier", async () => {
    let called = false
    await withMockedFetch((originalFetch) => ((...args: Parameters<typeof fetch>) => {
      called = true
      return originalFetch(...args)
    }) as typeof fetch, async () => {
      try {
        await inspectSpacesNamespace(env, "@xn--238746723487")
        throw new Error("expected inspectSpacesNamespace to reject")
      } catch (error) {
        expect(error).toMatchObject({
          status: 400,
          code: "bad_request",
        })
      }
      expect(called).toBe(false)
    })
  })

  test("maps verifier 5xx responses to provider unavailable", async () => {
    await withMockedFetch(() => (async () => new Response(JSON.stringify({
      error: "spaced rpc request failed",
    }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })) as typeof fetch, async () => {
      try {
        await inspectSpacesNamespace(env, "@pirate")
        throw new Error("expected inspectSpacesNamespace to reject")
      } catch (error) {
        expect(error).toMatchObject({
          status: 502,
          code: "provider_unavailable",
          retryable: true,
        })
      }
    })
  })

  test("spaces verifier requires an auth token in production", async () => {
    let called = false
    await withMockedFetch((originalFetch) => ((...args: Parameters<typeof fetch>) => {
      called = true
      return originalFetch(...args)
    }) as typeof fetch, async () => {
      try {
        await inspectSpacesNamespace({
          ENVIRONMENT: "production",
          SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
        } as any, "@pirate")
        throw new Error("expected inspectSpacesNamespace to reject")
      } catch (error) {
        expect(error).toMatchObject({
          status: 502,
          code: "provider_unavailable",
        })
      }
      expect(called).toBe(false)
    })
  })
})

describe("verifySpacesFabricPublish", () => {
  const env = {
    SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
  } as any

  test("rejects malformed root labels before calling the verifier", async () => {
    let called = false
    await withMockedFetch((originalFetch) => ((...args: Parameters<typeof fetch>) => {
      called = true
      return originalFetch(...args)
    }) as typeof fetch, async () => {
      try {
        await verifySpacesFabricPublish(env, {
          rootLabel: "bad.root",
          txtKey: "pirate-verify",
          txtValue: "pirate-space-verify=nvs_123",
          webUrl: "https://pirate.sc/c/@bad.root",
          freedomUrl: "https://pirate.sc/c/@bad.root",
        })
        throw new Error("expected verifySpacesFabricPublish to reject")
      } catch (error) {
        expect(error).toMatchObject({
          status: 400,
          code: "bad_request",
        })
      }
      expect(called).toBe(false)
    })
  })

  test("fails closed when aggregate publish success conflicts with component checks", async () => {
    await withMockedFetch(() => (async () => new Response(JSON.stringify({
      fabric_publish_verified: true,
      root_key_proof_verified: true,
      web_target_verified: false,
      freedom_target_verified: true,
      observation_provider: "spaces_verifier+fabric_zone",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch, async () => {
      try {
        await verifySpacesFabricPublish(env, {
          rootLabel: "pirate",
          txtKey: "pirate-verify",
          txtValue: "pirate-space-verify=nvs_123",
          webUrl: "https://pirate.sc/c/@pirate",
          freedomUrl: "https://pirate.sc/c/@pirate",
        })
        throw new Error("expected verifySpacesFabricPublish to reject")
      } catch (error) {
        expect(error).toMatchObject({
          status: 502,
          code: "provider_unavailable",
          retryable: true,
        })
      }
    })
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

describe("inspectHnsRoot", () => {
  test("rejects malformed root labels before calling the verifier", async () => {
    let called = false
    await withMockedFetch((originalFetch) => ((...args: Parameters<typeof fetch>) => {
      called = true
      return originalFetch(...args)
    }) as typeof fetch, async () => {
      try {
        await inspectHnsRoot({
          HNS_VERIFIER_BASE_URL: "http://hns.test",
        } as any, {
          rootLabel: "bad.root",
        })
        throw new Error("expected inspectHnsRoot to reject")
      } catch (error) {
        expect(error).toMatchObject({
          status: 400,
          code: "bad_request",
        })
      }
      expect(called).toBe(false)
    })
  })

  test("hns verifier requires an auth token in production", async () => {
    let called = false
    await withMockedFetch((originalFetch) => ((...args: Parameters<typeof fetch>) => {
      called = true
      return originalFetch(...args)
    }) as typeof fetch, async () => {
      try {
        await inspectHnsRoot({
          ENVIRONMENT: "production",
          HNS_VERIFIER_BASE_URL: "http://hns.test",
        } as any, {
          rootLabel: "pirate",
        })
        throw new Error("expected inspectHnsRoot to reject")
      } catch (error) {
        expect(error).toMatchObject({
          status: 502,
          code: "provider_unavailable",
        })
      }
      expect(called).toBe(false)
    })
  })

  test("hns verifier reports non-json upstream responses as provider unavailable", async () => {
    await withMockedFetch(() => (async () => new Response("<!doctype html><title>wrong server</title>", {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as typeof fetch, async () => {
      try {
        await inspectHnsRoot({
          HNS_VERIFIER_BASE_URL: "http://hns.test",
        } as any, {
          rootLabel: "pirate",
        })
        throw new Error("expected inspectHnsRoot to reject")
      } catch (error) {
        expect(error).toMatchObject({
          status: 502,
          code: "provider_unavailable",
          retryable: true,
          message: "HNS verifier returned non-JSON response with status 404 (text/html; charset=utf-8)",
          details: {
            verifier_origin: "http://hns.test",
            verifier_path: "/inspect?root_label=pirate",
          },
        })
      }
    })
  })
})
