import { describe, expect, test } from "bun:test"

import {
  COMMENT_CREATE_RATE_LIMIT,
  COMMENT_CREATE_RATE_LIMIT_WINDOW_MS,
  enforceCommentCreateRateLimit,
  evaluateCommentCreateRateLimit,
  type CommentCreateRateLimitDecision,
} from "./comment-create-rate-limit"

describe("evaluateCommentCreateRateLimit", () => {
  test("allows the first request and starts a window", () => {
    expect(evaluateCommentCreateRateLimit(null, 1_000)).toEqual({
      allowed: true,
      count: 1,
      retryAfterSeconds: 0,
      windowStartedAt: 1_000,
    })
  })

  test("allows through the twentieth request and rejects the twenty-first", () => {
    const twentieth = evaluateCommentCreateRateLimit(
      { count: COMMENT_CREATE_RATE_LIMIT - 1, windowStartedAt: 1_000 },
      30_000,
    )
    expect(twentieth.allowed).toBe(true)
    expect(twentieth.count).toBe(COMMENT_CREATE_RATE_LIMIT)

    expect(evaluateCommentCreateRateLimit(twentieth, 30_001)).toEqual({
      allowed: false,
      count: COMMENT_CREATE_RATE_LIMIT,
      retryAfterSeconds: 31,
      windowStartedAt: 1_000,
    })
  })

  test("starts a fresh window after expiry", () => {
    expect(
      evaluateCommentCreateRateLimit(
        { count: COMMENT_CREATE_RATE_LIMIT, windowStartedAt: 1_000 },
        1_000 + COMMENT_CREATE_RATE_LIMIT_WINDOW_MS,
      ),
    ).toEqual({
      allowed: true,
      count: 1,
      retryAfterSeconds: 0,
      windowStartedAt: 1_000 + COMMENT_CREATE_RATE_LIMIT_WINDOW_MS,
    })
  })
})

describe("enforceCommentCreateRateLimit", () => {
  const decision = (allowed: boolean): CommentCreateRateLimitDecision => ({
    allowed,
    count: allowed ? 1 : COMMENT_CREATE_RATE_LIMIT,
    retryAfterSeconds: allowed ? 0 : 42,
    windowStartedAt: 1_000,
  })

  test("uses the user id as the Durable Object name", async () => {
    let seenName = ""
    const namespace = {
      getByName(name: string) {
        seenName = name
        return { consume: async () => decision(true) }
      },
    }

    await enforceCommentCreateRateLimit(namespace, "user_123")
    expect(seenName).toBe("user_123")
  })

  test("throws a 429 rate_limited error when the limit is exceeded", async () => {
    const namespace = {
      getByName: () => ({ consume: async () => decision(false) }),
    }

    await expect(enforceCommentCreateRateLimit(namespace, "user_123")).rejects.toMatchObject({
      code: "rate_limited",
      details: { retry_after_seconds: 42, scope: "comment_create" },
      status: 429,
    })
  })

  test("allows requests when the binding is absent in local tests", async () => {
    await expect(enforceCommentCreateRateLimit(undefined, "user_123")).resolves.toBeUndefined()
  })
})
