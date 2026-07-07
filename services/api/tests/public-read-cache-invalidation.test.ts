import { describe, expect, test } from "bun:test"

import {
  publicPostCacheTags,
  purgePublicReadCacheTags,
  schedulePublicPostCachePurge,
} from "../src/lib/public-read-cache-invalidation"
import type { Env } from "../src/env"

describe("public read cache invalidation", () => {
  test("builds public post and community cache tags", () => {
    expect(publicPostCacheTags({
      communityId: "cmt_123",
      postId: "pst_456",
    })).toEqual(["post:post_pst_456", "community:com_cmt_123"])
  })

  test("skips Cloudflare purge when config is absent", async () => {
    let called = false
    await purgePublicReadCacheTags({
      env: {},
      tags: ["post:post_pst_1"],
      fetcher: (async () => {
        called = true
        return new Response("{}")
      }) as typeof fetch,
    })

    expect(called).toBe(false)
  })

  test("purges Cloudflare cache by tag when configured", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    await purgePublicReadCacheTags({
      env: {
        CLOUDFLARE_CACHE_PURGE_ZONE_ID: "zone_123",
        CLOUDFLARE_CACHE_PURGE_API_TOKEN: "token_abc",
      } satisfies Env,
      tags: ["post:post_pst_1", "post:post_pst_1", "community:com_cmt_1"],
      fetcher: (async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }) as typeof fetch,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/zones/zone_123/purge_cache")
    expect(calls[0]?.init?.method).toBe("POST")
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer token_abc")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      tags: ["post:post_pst_1", "community:com_cmt_1"],
    })
  })

  test("rejects Cloudflare cache purge responses without success true", async () => {
    await expect(purgePublicReadCacheTags({
      env: {
        CLOUDFLARE_CACHE_PURGE_ZONE_ID: "zone_123",
        CLOUDFLARE_CACHE_PURGE_API_TOKEN: "token_abc",
      } satisfies Env,
      tags: ["post:post_pst_1"],
      fetcher: (async () => new Response(JSON.stringify({
        success: false,
        errors: [{ code: 1000, message: "invalid tag" }],
      }), { status: 200 })) as typeof fetch,
    })).rejects.toThrow(/did not report success/)
  })

  test("reports scheduled purge failures to Sentry when configured", async () => {
    const captured: Array<{ error: unknown; context: unknown }> = []
    let scheduled: Promise<void> | null = null
    const originalConsoleError = console.error
    console.error = () => {}
    try {
      await schedulePublicPostCachePurge({
        env: {
          CLOUDFLARE_CACHE_PURGE_ZONE_ID: "zone_123",
          CLOUDFLARE_CACHE_PURGE_API_TOKEN: "token_abc",
          SENTRY_DSN: "https://example.invalid/1",
        } as Env,
        postId: "pst_1",
        communityId: "cmt_1",
        waitUntil: (promise) => {
          scheduled = promise
        },
        captureException: (error, context) => {
          captured.push({ error, context })
        },
        fetcher: (async () => new Response(JSON.stringify({ success: false }), { status: 200 })) as typeof fetch,
      })
      await scheduled
    } finally {
      console.error = originalConsoleError
    }

    expect(captured).toHaveLength(1)
    expect(captured[0]?.error).toBeInstanceOf(Error)
    expect(captured[0]?.context).toMatchObject({
      level: "error",
      tags: {
        component: "public_read_cache",
        operation: "purge",
      },
      extra: {
        post_id: "pst_1",
        community_id: "cmt_1",
        cache_tags: ["post:post_pst_1", "community:com_cmt_1"],
      },
    })
  })

  test("sends configured ops alert when a scheduled purge fails", async () => {
    const sent: Array<{ subject?: string; text?: string }> = []
    let scheduled: Promise<void> | null = null
    const originalConsoleError = console.error
    console.error = () => {}
    try {
      await schedulePublicPostCachePurge({
        env: {
          CLOUDFLARE_CACHE_PURGE_ZONE_ID: "zone_123",
          CLOUDFLARE_CACHE_PURGE_API_TOKEN: "token_abc",
          ENVIRONMENT: "production",
          OPS_ALERT_EMAIL_FROM: "alerts@pirate.sc",
          OPS_ALERT_EMAIL_TO: "ops@example.com",
          OPS_ALERT_EMAIL: {
            send: async (message: { subject?: string; text?: string }) => {
              sent.push(message)
              return { messageId: "msg_test" }
            },
          },
        } as unknown as Env,
        postId: "pst_1",
        communityId: "cmt_1",
        waitUntil: (promise) => {
          scheduled = promise
        },
        fetcher: (async () => new Response(JSON.stringify({ success: false }), { status: 200 })) as typeof fetch,
      })
      await scheduled
    } finally {
      console.error = originalConsoleError
    }

    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe("[Pirate production] Public read cache purge failed")
    expect(sent[0]?.text).toContain("[HIGH][production] Public read cache purge failed")
    expect(sent[0]?.text).toContain("\"post_id\":\"pst_1\"")
    expect(sent[0]?.text).toContain("\"community_id\":\"cmt_1\"")
  })

  test("sends a Sentry envelope when no captureException hook is provided", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let scheduled: Promise<void> | null = null
    const originalConsoleError = console.error
    console.error = () => {}
    try {
      await schedulePublicPostCachePurge({
        env: {
          CLOUDFLARE_CACHE_PURGE_ZONE_ID: "zone_123",
          CLOUDFLARE_CACHE_PURGE_API_TOKEN: "token_abc",
          ENVIRONMENT: "production",
          SENTRY_DSN: "https://public@example.invalid/42",
        } as Env,
        postId: "pst_1",
        communityId: "cmt_1",
        waitUntil: (promise) => {
          scheduled = promise
        },
        fetcher: (async (url, init) => {
          calls.push({ url: String(url), init })
          if (String(url).includes("/purge_cache")) {
            return new Response(JSON.stringify({ success: false }), { status: 200 })
          }
          return new Response("", { status: 200 })
        }) as typeof fetch,
      })
      await scheduled
    } finally {
      console.error = originalConsoleError
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/zones/zone_123/purge_cache")
    expect(calls[1]?.url).toBe("https://example.invalid/api/42/envelope/")
    expect((calls[1]?.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-sentry-envelope")
    const envelope = String(calls[1]?.init?.body)
    expect(envelope).toContain("Public read cache purge failed")
    expect(envelope).toContain("\"post_id\":\"pst_1\"")
    expect(envelope).toContain("\"community_id\":\"cmt_1\"")
  })
})
