import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import { COMMENT_CREATE_RATE_LIMIT } from "../../src/lib/comment-create-rate-limit"

let sequence = 0

function freshStub() {
  return env.COMMENT_CREATE_RATE_LIMITER.getByName(`comment-rate-limit-test-${sequence++}`)
}

describe("CommentCreateRateLimiterDO (real workerd isolate)", () => {
  it("allows exactly twenty concurrent requests in one window", async () => {
    const stub = freshStub()
    const decisions = await Promise.all(
      Array.from({ length: COMMENT_CREATE_RATE_LIMIT + 1 }, () => stub.consume()),
    )

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(COMMENT_CREATE_RATE_LIMIT)
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(1)
    expect(decisions.at(-1)).toMatchObject({
      allowed: false,
      count: COMMENT_CREATE_RATE_LIMIT,
    })

    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ request_count: number }>(
            "SELECT request_count FROM rate_limit_state WHERE id = 1",
          )
          .one().request_count,
      ).toBe(COMMENT_CREATE_RATE_LIMIT)
    })
  })

  it("isolates counters by user", async () => {
    const firstUser = freshStub()
    const secondUser = freshStub()

    for (let index = 0; index < COMMENT_CREATE_RATE_LIMIT; index += 1) {
      expect((await firstUser.consume()).allowed).toBe(true)
    }

    expect((await firstUser.consume()).allowed).toBe(false)
    expect(await secondUser.consume()).toMatchObject({ allowed: true, count: 1 })
  })
})
