/**
 * Real, self-cleaning staging synthetic for Telegram channel publication:
 * admin impersonation → public text post → queued community job → real Bot API
 * delivery → Telegram delete → Pirate post delete.
 *
 * Successful and definite-failure runs clean up automatically. An ambiguous
 * Telegram send is intentionally preserved for operator review because no
 * outbound-only client can recover the missing message id safely.
 */

import { appendFile } from "node:fs/promises"
import { asObject, asString } from "./staging-smoke-support"
import {
  TELEGRAM_SYNTHETIC_BODY,
  TELEGRAM_SYNTHETIC_TITLE_PREFIX,
} from "../src/lib/telegram/telegram-synthetic-contract"
import {
  telegramCadenceOutcome,
  type TelegramCadenceOutcome,
} from "../src/lib/telegram/telegram-cadence-outcome"

type Json = Record<string, unknown>

const prefix = "telegram-channel-smoke"
const apiBase = (process.env.PIRATE_SMOKE_API_BASE_URL ?? "https://api-staging.pirate.sc").replace(/\/+$/u, "")
const adminCredential = String(process.env.PIRATE_ADMIN_OPERATOR_CREDENTIAL ?? "").trim()
const configuredCommunity = String(process.env.PIRATE_TELEGRAM_SMOKE_COMMUNITY_ID ?? "").trim()
const timeoutMs = Number(process.env.PIRATE_TELEGRAM_SMOKE_TIMEOUT_MS ?? 20 * 60_000)
const latencySloMs = Number(
  process.env.PIRATE_TELEGRAM_SMOKE_LATENCY_SLO_MS ?? 15 * 60_000,
)
const pollMs = Number(process.env.PIRATE_TELEGRAM_SMOKE_POLL_MS ?? 15_000)
const networkAttempts = 3
const dispatchMode = String(
  process.env.PIRATE_TELEGRAM_SMOKE_DISPATCH_MODE ?? "deterministic",
).trim()

if (!adminCredential) throw new Error("PIRATE_ADMIN_OPERATOR_CREDENTIAL is required")
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("PIRATE_TELEGRAM_SMOKE_TIMEOUT_MS must be positive")
}
if (!Number.isFinite(latencySloMs) || latencySloMs <= 0) {
  throw new Error("PIRATE_TELEGRAM_SMOKE_LATENCY_SLO_MS must be positive")
}
if (dispatchMode !== "deterministic" && dispatchMode !== "cron") {
  throw new Error("PIRATE_TELEGRAM_SMOKE_DISPATCH_MODE must be deterministic or cron")
}
if (!new URL(apiBase).hostname.includes("staging")) {
  throw new Error("Telegram channel synthetic is staging-only")
}

async function request(input: {
  method?: string
  path: string
  body?: Json
  asUserId?: string
  okStatuses?: number[]
}): Promise<Json> {
  let response: Response | null = null
  let lastNetworkError: unknown
  for (let attempt = 1; attempt <= networkAttempts; attempt += 1) {
    try {
      response = await fetch(`${apiBase}${input.path}`, {
        method: input.method ?? "GET",
        headers: {
          "content-type": "application/json",
          Authorization: `Operator ${adminCredential}`,
          ...(input.asUserId ? { "x-admin-as-user-id": input.asUserId } : {}),
        },
        body: input.body ? JSON.stringify(input.body) : undefined,
      })
      break
    } catch (error) {
      lastNetworkError = error
      if (attempt < networkAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
      }
    }
  }
  if (!response) {
    throw lastNetworkError
  }
  const text = await response.text()
  const payload = text ? JSON.parse(text) as Json : {}
  if (!(input.okStatuses ?? [200, 201]).includes(response.status)) {
    throw new Error(`${input.method ?? "GET"} ${input.path} -> ${response.status}: ${text.slice(0, 1000)}`)
  }
  return payload
}

function withCommunity(path: string, communityId: string): string {
  const separator = path.includes("?") ? "&" : "?"
  return `${path}${separator}community_id=${encodeURIComponent(communityId)}`
}

const fixtureQuery = configuredCommunity
  ? `?community_id=${encodeURIComponent(configuredCommunity)}`
  : ""
const fixture = await request({
  path: `/admin/ops/telegram/synthetic-fixture${fixtureQuery}`,
})
const communityId = asString(fixture.community_id, "fixture.community_id", prefix)
const ownerUserId = asString(fixture.owner_user_id, "fixture.owner_user_id", prefix)
const marker = `${TELEGRAM_SYNTHETIC_TITLE_PREFIX}${Date.now()}`
let postId: string | null = null
let lastDelivery: Json | null = null
let telegramCleaned = false
let publishedAtMs: number | null = null
let deliveryObservedAtMs: number | null = null

async function reportCadence(input: {
  outcome: TelegramCadenceOutcome
  latencyMs: number
}): Promise<void> {
  const latencySeconds = (input.latencyMs / 1_000).toFixed(1)
  const sloSeconds = (latencySloMs / 1_000).toFixed(0)
  console.log(`[${prefix}] scheduler cadence`, {
    outcome: input.outcome,
    observed_delivery_latency_ms: input.latencyMs,
    latency_slo_ms: latencySloMs,
  })
  const summaryPath = String(process.env.GITHUB_STEP_SUMMARY ?? "").trim()
  if (summaryPath) {
    await appendFile(
      summaryPath,
      [
        "### Telegram scheduler cadence",
        "",
        `- Outcome: **${input.outcome}**`,
        `- Observed publication-to-delivery latency: **${latencySeconds}s**`,
        `- Latency SLO: **${sloSeconds}s**`,
        "",
      ].join("\n"),
    )
  }
}

console.log(`[${prefix}] fixture`, {
  community_id: communityId,
  channel_title: fixture.channel_title,
})

try {
  const post = await request({
    method: "POST",
    path: `/communities/${encodeURIComponent(communityId)}/posts`,
    asUserId: ownerUserId,
    body: {
      post_type: "text",
      identity_mode: "public",
      title: marker,
      body: TELEGRAM_SYNTHETIC_BODY,
      idempotency_key: marker,
    },
  })
  postId = asString(post.id, "post.id", prefix)
  if (post.status !== "published" || post.visibility !== "public") {
    throw new Error(`post was not published/public: ${JSON.stringify({
      status: post.status,
      visibility: post.visibility,
    })}`)
  }
  publishedAtMs = Date.now()
  console.log(`[${prefix}] post published`, { post_id: postId })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (dispatchMode === "deterministic") {
      const drained = await request({
        method: "POST",
        path: withCommunity("/admin/ops/telegram/synthetic-fixture/drain", communityId),
      })
      if (Number(drained.failed_communities) > 0) {
        throw new Error("fixture-scoped community job drain failed")
      }
    }
    const state = await request({
      path: withCommunity(
        `/admin/ops/telegram/synthetic-deliveries/${encodeURIComponent(postId)}`,
        communityId,
      ),
    })
    lastDelivery = state.delivery == null
      ? null
      : asObject(state.delivery, "delivery", prefix)
    const status = lastDelivery?.status
    if (status === "delivered") {
      deliveryObservedAtMs = Date.now()
      break
    }
    if (status === "uncertain" || status === "sending") {
      throw new Error(`delivery outcome is ambiguous (${status}); preserved for operator review`)
    }
    if (status === "failed") {
      throw new Error(`delivery failed: ${String(lastDelivery?.last_error ?? "unknown")}`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  if (lastDelivery?.status !== "delivered") {
    if (dispatchMode === "cron" && publishedAtMs != null) {
      await reportCadence({
        outcome: telegramCadenceOutcome({
          delivered: false,
          elapsedMs: Date.now() - publishedAtMs,
          latencySloMs,
        }),
        latencyMs: Date.now() - publishedAtMs,
      })
    }
    throw new Error(`delivery did not complete within ${timeoutMs}ms`)
  }
  const messageId = Number(lastDelivery.telegram_message_id)
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new Error("delivered row has no valid telegram_message_id")
  }
  if (Number(lastDelivery.attempt_count) !== 1) {
    throw new Error(`expected one Telegram attempt, got ${String(lastDelivery.attempt_count)}`)
  }
  console.log(`[${prefix}] real Telegram delivery confirmed`, {
    delivery_id: lastDelivery.delivery_id,
    telegram_message_id: messageId,
    attempt_count: lastDelivery.attempt_count,
  })

  const cleanup = await request({
    method: "POST",
    path: withCommunity(
      `/admin/ops/telegram/synthetic-deliveries/${encodeURIComponent(postId)}/cleanup`,
      communityId,
    ),
  })
  const cleanedDelivery = asObject(cleanup.delivery, "cleanup.delivery", prefix)
  if (cleanedDelivery.status !== "deleted") {
    throw new Error(`Telegram cleanup did not retire the delivery: ${JSON.stringify(cleanup)}`)
  }
  telegramCleaned = true
  console.log(`[${prefix}] Telegram message deleted`)

  if (
    dispatchMode === "cron"
    && publishedAtMs != null
    && deliveryObservedAtMs != null
  ) {
    const latencyMs = deliveryObservedAtMs - publishedAtMs
    const outcome = telegramCadenceOutcome({
      delivered: true,
      elapsedMs: latencyMs,
      latencySloMs,
    })
    await reportCadence({ outcome, latencyMs })
    if (outcome === "latency_breach") {
      throw new Error(
        `delivery completed but breached the ${latencySloMs}ms latency SLO (${latencyMs}ms)`,
      )
    }
  }
} finally {
  if (
    postId
    && (
      telegramCleaned
      || lastDelivery?.status === "failed"
      || (dispatchMode === "deterministic" && lastDelivery == null)
    )
  ) {
    await request({
      method: "POST",
      path: `/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}/delete`,
      asUserId: ownerUserId,
    })
    console.log(`[${prefix}] Pirate post deleted`)
  } else if (postId) {
    console.error(`[${prefix}] preserving Pirate post for ambiguous/unconfirmed delivery`, {
      post_id: postId,
      status: lastDelivery?.status ?? null,
    })
  }
}

console.log(`[${prefix}] PASS`)
