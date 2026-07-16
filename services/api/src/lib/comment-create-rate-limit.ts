import { DurableObject } from "cloudflare:workers"

import type { Env } from "../env"
import { rateLimited } from "./errors"

export const COMMENT_CREATE_RATE_LIMIT = 20
export const COMMENT_CREATE_RATE_LIMIT_WINDOW_MS = 60_000

export type CommentCreateRateLimitDecision = {
  allowed: boolean
  count: number
  retryAfterSeconds: number
  windowStartedAt: number
}

type CommentCreateRateLimitState = {
  count: number
  windowStartedAt: number
}

type CommentCreateRateLimiterStubLike = {
  consume(): Promise<CommentCreateRateLimitDecision>
}

type CommentCreateRateLimiterNamespaceLike = {
  getByName(name: string): CommentCreateRateLimiterStubLike
}

export function evaluateCommentCreateRateLimit(
  current: CommentCreateRateLimitState | null,
  now: number,
): CommentCreateRateLimitDecision {
  if (!current || now >= current.windowStartedAt + COMMENT_CREATE_RATE_LIMIT_WINDOW_MS) {
    return {
      allowed: true,
      count: 1,
      retryAfterSeconds: 0,
      windowStartedAt: now,
    }
  }

  if (current.count >= COMMENT_CREATE_RATE_LIMIT) {
    return {
      allowed: false,
      count: current.count,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((current.windowStartedAt + COMMENT_CREATE_RATE_LIMIT_WINDOW_MS - now) / 1_000),
      ),
      windowStartedAt: current.windowStartedAt,
    }
  }

  return {
    allowed: true,
    count: current.count + 1,
    retryAfterSeconds: 0,
    windowStartedAt: current.windowStartedAt,
  }
}

/**
 * Per-user fixed-window limiter for comment creation. Each user maps to a
 * separate Durable Object, so concurrent attempts serialize without a global
 * bottleneck. State is persisted before the RPC returns.
 */
export class CommentCreateRateLimiterDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS rate_limit_state (id INTEGER PRIMARY KEY CHECK (id = 1), window_started_at INTEGER NOT NULL, request_count INTEGER NOT NULL)",
      )
    })
  }

  consume(): CommentCreateRateLimitDecision {
    const now = Date.now()
    const rows = this.ctx.storage.sql
      .exec<{ request_count: number; window_started_at: number }>(
        "SELECT request_count, window_started_at FROM rate_limit_state WHERE id = 1",
      )
      .toArray()
    const row = rows[0]
    const decision = evaluateCommentCreateRateLimit(
      row
        ? {
            count: Number(row.request_count),
            windowStartedAt: Number(row.window_started_at),
          }
        : null,
      now,
    )

    if (decision.allowed) {
      this.ctx.storage.sql.exec(
        "INSERT INTO rate_limit_state (id, window_started_at, request_count) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET window_started_at = excluded.window_started_at, request_count = excluded.request_count",
        decision.windowStartedAt,
        decision.count,
      )
    }

    return decision
  }
}

export async function enforceCommentCreateRateLimit(
  namespace: CommentCreateRateLimiterNamespaceLike | undefined | null,
  userId: string,
): Promise<void> {
  if (!namespace) {
    console.warn("[comment-create-rate-limit] limiter binding missing; allowing request")
    return
  }

  const decision = await namespace.getByName(userId).consume()
  if (!decision.allowed) {
    throw rateLimited("Comment rate limit exceeded", {
      retry_after_seconds: decision.retryAfterSeconds,
      scope: "comment_create",
    })
  }
}
