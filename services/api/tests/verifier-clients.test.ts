import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SPACES_FABRIC_PUBLISH_CHALLENGE_TTL_HOURS,
  getSpacesFabricPublishChallengeTtlMs,
  inspectSpacesNamespace,
  normalizeRootLabel,
  mintSpacesChallenge,
  verifySpacesFabricPublish,
} from "../src/lib/verification/spaces-verifier"
import { assertHnsRootLabel, ensureHnsZone, getHnsVerifierBaseUrl, inspectHnsRoot, isHnsVerifierConfigured, normalizeHnsRootLabel, verifyHnsTxtRecord } from "../src/lib/verification/hns-verifier"
import { withMockedFetch } from "./helpers"

function urlFromFetchInput(input: Parameters<typeof fetch>[0]): URL {
  return new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url)
}

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

describe("normalizeHnsRootLabel", () => {
  test("keeps underscores in HNS labels", () => {
    expect(normalizeHnsRootLabel("Tame_Impala")).toBe("tame_impala")
  })

  test("validates the hsd covenant root-label grammar", () => {
    for (const label of ["pirate", "tame_impala", "a--b", "a".repeat(63)]) {
      expect(() => assertHnsRootLabel(label)).not.toThrow()
    }

    for (const label of [
      "_leading",
      "trailing_",
      "-leading",
      "trailing-",
      "a".repeat(64),
      "example",
      "invalid",
      "local",
      "localhost",
      "test",
    ]) {
      expect(() => assertHnsRootLabel(label)).toThrow("HNS root label must be a protocol root label")
    }
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
    expect(expiresAt - issuedAt).toBe(getSpacesFabricPublishChallengeTtlMs(env))
    expect(getSpacesFabricPublishChallengeTtlMs(env)).toBe(
      DEFAULT_SPACES_FABRIC_PUBLISH_CHALLENGE_TTL_HOURS * 60 * 60 * 1000,
    )
  })

  test("challenge expiry supports a bounded Spaces TTL override", async () => {
    const customEnv = { ...env, SPACES_CHALLENGE_TTL_HOURS: "72" } as any
    const result = await mintSpacesChallenge(customEnv, "myspace", "test-pubkey", "nvs_123")
    const issuedAt = new Date(result.challengePayload.issued_at).getTime()
    const expiresAt = new Date(result.challengeExpiresAt).getTime()
    expect(expiresAt - issuedAt).toBe(72 * 60 * 60 * 1000)
    expect(getSpacesFabricPublishChallengeTtlMs({ ...env, SPACES_CHALLENGE_TTL_HOURS: "999" } as any)).toBe(
      DEFAULT_SPACES_FABRIC_PUBLISH_CHALLENGE_TTL_HOURS * 60 * 60 * 1000,
    )
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
    await withMockedFetch(() => (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString()
      return new Response(JSON.stringify({
        root_exists: true,
        root_key_proof_verified: true,
        root_pubkey: "spaces-root-pubkey",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }), async () => {
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
    }), async () => {
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
    }), async () => {
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
    })), async () => {
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
    }), async () => {
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
    }), async () => {
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
    })), async () => {
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

  test("rejects URL ending with /inspect-public", () => {
    expect(() => getHnsVerifierBaseUrl({ HNS_VERIFIER_BASE_URL: "http://hns.test/inspect-public" } as any)).toThrow()
  })

  test("rejects URL ending with /verify-txt", () => {
    expect(() => getHnsVerifierBaseUrl({ HNS_VERIFIER_BASE_URL: "http://hns.test/verify-txt" } as any)).toThrow()
  })

  test("rejects URL ending with /verify-txt-public", () => {
    expect(() => getHnsVerifierBaseUrl({ HNS_VERIFIER_BASE_URL: "http://hns.test/verify-txt-public" } as any)).toThrow()
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
    }), async () => {
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
    }), async () => {
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
    })), async () => {
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
            verifier_path: "/inspect-public?root_label=pirate",
          },
        })
      }
    })
  })

  test("inspection uses public resolver endpoint", async () => {
    let requestedPath = ""
    await withMockedFetch(() => (async (input: RequestInfo | URL) => {
      const url = urlFromFetchInput(input)
      requestedPath = `${url.pathname}?${url.searchParams.toString()}`
      return Response.json({
        pirate_dns_authority_verified: true,
        observation_provider: "web3dns_json_doh",
      })
    }), async () => {
      const result = await inspectHnsRoot({
        HNS_VERIFIER_BASE_URL: "http://hns.test",
      } as any, {
        rootLabel: "pirate",
      })
      expect(result.observation_provider).toBe("web3dns_json_doh")
      expect(requestedPath).toBe("/inspect-public?root_label=pirate")
    })
  })

  test("allows underscores in HNS root labels", async () => {
    let requestedPath = ""
    await withMockedFetch(() => (async (input: RequestInfo | URL) => {
      const url = urlFromFetchInput(input)
      requestedPath = `${url.pathname}?${url.searchParams.toString()}`
      return Response.json({
        root_label: "tame_impala",
        pirate_dns_authority_verified: true,
        observation_provider: "web3dns_json_doh",
      })
    }), async () => {
      const result = await inspectHnsRoot({
        HNS_VERIFIER_BASE_URL: "http://hns.test",
      } as any, {
        rootLabel: "tame_impala",
      })
      expect(result.root_label).toBe("tame_impala")
      expect(requestedPath).toBe("/inspect-public?root_label=tame_impala")
    })
  })
})

describe("verifyHnsTxtRecord", () => {
  test("TXT verification uses public resolver endpoint", async () => {
    let requestedPath = ""
    await withMockedFetch(() => (async (input: RequestInfo | URL) => {
      const url = urlFromFetchInput(input)
      requestedPath = url.pathname
      return Response.json({
        verified: true,
        observation_provider: "web3dns_json_doh",
        expiry_height: 1_250_000,
        expiry_anchor_height: 1_200_000,
        expiry_blocks_remaining: 50_000,
        expiry_horizon_blocks: 25_000,
        expiry_observation_provider: "hsd_json_rpc",
      })
    }), async () => {
      const result = await verifyHnsTxtRecord({
        HNS_VERIFIER_BASE_URL: "http://hns.test",
      } as any, {
        rootLabel: "pirate",
        challengeTxtValue: "pirate-verification=nvs_test",
      })
      expect(result.verified).toBe(true)
      expect(result.observation_provider).toBe("web3dns_json_doh")
      expect(result.expiry_height).toBe(1_250_000)
      expect(result.expiry_observation_provider).toBe("hsd_json_rpc")
      expect(requestedPath).toBe("/verify-txt-public")
    })
  })
})

describe("ensureHnsZone", () => {
  test("zone provisioning uses the authenticated verifier endpoint", async () => {
    const env = {
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
      HNS_VERIFIER_AUTH_TOKEN: "test-hns-token",
    } as any
    let capturedUrl: string | null = null
    let capturedBody: unknown = null
    let capturedAuthorization: string | null = null

    await withMockedFetch(() => (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString()
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null
      capturedAuthorization = new Headers(init?.headers).get("authorization")
      return new Response(JSON.stringify({
        root_label: "xn--pokmon-dva",
        zone_name: "xn--pokmon-dva.",
        zone_created: true,
        nameservers: ["ns1.pirate."],
        observation_provider: "powerdns_sqlite",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }), async () => {
      const result = await ensureHnsZone(env, {
        rootLabel: "xn--pokmon-dva",
      })

      expect(capturedUrl).toBe("http://hns-verifier.test/ensure-zone")
      expect(capturedBody).toEqual({ root_label: "xn--pokmon-dva" })
      expect(capturedAuthorization).toBe("Bearer test-hns-token")
      expect(result.zone_name).toBe("xn--pokmon-dva.")
    })
  })
})
