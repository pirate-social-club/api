import { describe, expect, test } from "bun:test"

import type { Env } from "../env"
import {
  publicCommunityCacheTags,
  purgePublicReadCacheTags,
} from "./public-read-cache-invalidation"

describe("public community cache invalidation", () => {
  test("purges one community tag from Workers cache plus API and Web zones", async () => {
    const workersPurges: string[][] = []
    const zoneRequests: Request[] = []
    const tags = publicCommunityCacheTags("cmt_test")
    const env = {
      CLOUDFLARE_CACHE_PURGE_API_TOKEN: "cache-purge-token",
      CLOUDFLARE_CACHE_PURGE_ZONE_ID: "zone-id",
      CLOUDFLARE_WEB_CACHE_PURGE_ZONE_ID: "web-zone-id",
      PUBLIC_READ_CACHE: {
        async purgeCacheTags(nextTags: string[]) {
          workersPurges.push(nextTags)
          return { success: true }
        },
      },
    } as unknown as Env

    await purgePublicReadCacheTags({
      env,
      fetcher: async (input, init) => {
        zoneRequests.push(new Request(input, init))
        return Response.json({ success: true })
      },
      tags,
    })

    expect(tags).toEqual(["community:com_cmt_test"])
    expect(workersPurges).toEqual([["community:com_cmt_test"]])
    expect(zoneRequests).toHaveLength(2)
    expect(zoneRequests[0]?.url).toBe("https://api.cloudflare.com/client/v4/zones/zone-id/purge_cache")
    expect(zoneRequests[1]?.url).toBe("https://api.cloudflare.com/client/v4/zones/web-zone-id/purge_cache")
    expect(await zoneRequests[0]?.json()).toEqual({ tags: ["community:com_cmt_test"] })
    expect(await zoneRequests[1]?.json()).toEqual({ tags: ["community:com_cmt_test"] })
  })
})
