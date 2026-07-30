import { describe, expect, test } from "bun:test"
import { listActiveTelegramChannelCommunityIds } from "./channel-destination-service"

describe("Telegram channel scheduler priority", () => {
  test("selects only active publishing destinations with a bounded query", async () => {
    const queries: Array<{ sql: string; args: unknown[] }> = []
    const communityIds = await listActiveTelegramChannelCommunityIds({
      client: {
        execute: async (query) => {
          queries.push(query)
          return {
            rows: [
              { community_id: "cmt_channel_1" },
              { community_id: "cmt_channel_2" },
            ],
          }
        },
      },
      limit: 25,
    })

    expect(communityIds).toEqual(["cmt_channel_1", "cmt_channel_2"])
    expect(queries[0]?.sql).toContain("status = 'active'")
    expect(queries[0]?.sql).toContain("publication_mode != 'off'")
    expect(queries[0]?.args).toEqual([25])
  })
})
