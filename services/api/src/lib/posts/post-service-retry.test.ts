import { describe, expect, test } from "bun:test"

import type { Post } from "../../types"
import { syncRetriedPostProjection } from "./post-service"

describe("syncRetriedPostProjection", () => {
  test("updates projection status and payload to processing after retry", async () => {
    const calls: Array<{ input: Record<string, unknown>; method: string }> = []
    const post = {
      post_id: "pst_retry",
      status: "processing",
      publish_failure_code: null,
      publish_failure_message: null,
      publish_failure_retryable: null,
      publish_failed_at: null,
    } as unknown as Post

    await syncRetriedPostProjection({
      communityRepository: {
        async updateCommunityPostProjectionStatus(input) {
          calls.push({ method: "status", input })
        },
        async updateCommunityPostProjectionPayload(input) {
          calls.push({ method: "payload", input })
        },
      },
      post,
      updatedAt: "2026-07-05T12:00:00.000Z",
    })

    expect(calls).toEqual([
      {
        method: "status",
        input: {
          postId: "pst_retry",
          status: "processing",
          updatedAt: "2026-07-05T12:00:00.000Z",
        },
      },
      {
        method: "payload",
        input: {
          postId: "pst_retry",
          projectedPayloadJson: JSON.stringify(post),
          updatedAt: "2026-07-05T12:00:00.000Z",
        },
      },
    ])
  })
})
