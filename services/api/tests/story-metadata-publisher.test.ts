import { afterEach, describe, expect, test } from "bun:test"
import type { Env } from "../src/env"
import { publishStoryJsonMetadata } from "../src/lib/story/story-metadata-publisher"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("story metadata publisher", () => {
  test("publishes Story metadata to Filebase when Swarm is not configured", async () => {
    const requests: Request[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      requests.push(request)
      return new Response("", {
        status: 200,
        headers: {
          "x-amz-meta-cid": "bafystorymetadatacid",
        },
      })
    }) as typeof globalThis.fetch

    const result = await publishStoryJsonMetadata({
      env: {
        FILEBASE_S3_ACCESS_KEY: "filebase-access-key",
        FILEBASE_S3_SECRET_KEY: "filebase-secret-key",
        FILEBASE_MEDIA_BUCKET: "pirate-media",
        FILEBASE_S3_ENDPOINT: "https://s3.filebase.com",
        FILEBASE_S3_REGION: "us-east-1",
      } as Env,
      path: "story-assets/cmt_test/ast_test/ip.json",
      payload: {
        kind: "pirate_story_ip_metadata",
        title: "Palestine, Don't Cry",
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe("PUT")
    expect(requests[0]?.url).toBe("https://s3.filebase.com/pirate-media/story-assets/cmt_test/ast_test/ip.json")
    expect(requests[0]?.headers.get("content-type")).toBe("application/json")
    expect(result.uri).toBe("ipfs://bafystorymetadatacid")
    expect(result.hash).toMatch(/^0x[a-f0-9]{64}$/)
  })
})
