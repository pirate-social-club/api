import { describe, expect, test } from "bun:test"

import {
  publicPostCacheTags,
  purgePublicReadCacheTags,
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
})
