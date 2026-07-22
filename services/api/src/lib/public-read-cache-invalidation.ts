import type { Env } from "../env"
import { sendOpsAlerts } from "./ops-alerts/sink"
import type { OpsAlert } from "./ops-alerts/types"
import { publicCommunityId, publicPostId } from "./public-ids"

type WaitUntil = (promise: Promise<void>) => void
type CaptureException = (
  exception: unknown,
  context?: {
    level?: "fatal" | "error" | "warning" | "log" | "info" | "debug"
    tags?: Record<string, string>
    extra?: Record<string, unknown>
  },
) => void

type PublicPostCachePurgeInput = {
  env: Env
  communityId?: string | null
  postId: string
  waitUntil?: WaitUntil
  captureException?: CaptureException
  fetcher?: typeof fetch
}

type PublicCommunityCachePurgeInput = {
  env: Env
  communityId: string
  waitUntil?: WaitUntil
  captureException?: CaptureException
  fetcher?: typeof fetch
}

export function publicPostCacheTags(input: {
  communityId?: string | null
  postId: string
}): string[] {
  const tags = [`post:${publicPostId(input.postId)}`]
  if (input.communityId) {
    tags.push(`community:${publicCommunityId(input.communityId)}`)
  }
  return tags
}

export function publicCommunityCacheTags(communityId: string): string[] {
  return [`community:${publicCommunityId(communityId)}`]
}

function cloudflareCachePurgeConfig(env: Env): { zoneId: string; token: string } | null {
  const zoneId = env.CLOUDFLARE_CACHE_PURGE_ZONE_ID?.trim()
    || env.CLOUDFLARE_ZONE_ID?.trim()
  const token = env.CLOUDFLARE_CACHE_PURGE_API_TOKEN?.trim()
    || env.CLOUDFLARE_API_TOKEN?.trim()
  if (!zoneId || !token) {
    return null
  }
  return { zoneId, token }
}

/**
 * Evicts the Workers Caching layer that fronts the `CachedPublicReads`
 * entrypoint.
 *
 * This is NOT covered by the zone purge below: per Cloudflare, no zone-level
 * purge affects Workers Caching content, and a Workers cache purge only applies
 * to the entrypoint that issues it. Public reads are served from that
 * entrypoint's cache, so without this call an invalidation is a silent no-op
 * and stale threads survive until their own TTL expires.
 */
async function purgeWorkersCacheTags(input: {
  env: Env
  tags: string[]
}): Promise<void> {
  const entrypoint = input.env.PUBLIC_READ_CACHE
  if (!entrypoint) {
    return
  }
  const result = await entrypoint.purgeCacheTags(input.tags)
  if (!result.success) {
    throw new Error(`Workers cache purge did not report success: ${JSON.stringify(result.errors ?? null).slice(0, 500)}`)
  }
}

async function purgeZoneCacheTags(input: {
  env: Env
  tags: string[]
  fetcher?: typeof fetch
}): Promise<void> {
  const config = cloudflareCachePurgeConfig(input.env)
  if (!config) {
    return
  }

  const response = await (input.fetcher ?? fetch)(
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(config.zoneId)}/purge_cache`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: [...new Set(input.tags)] }),
    },
  )
  const bodyText = await response.text().catch(() => "")
  if (!response.ok) {
    throw new Error(`Cloudflare cache purge failed with ${response.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`)
  }

  let body: { success?: unknown; errors?: unknown } | null = null
  try {
    body = bodyText ? JSON.parse(bodyText) as { success?: unknown; errors?: unknown } : null
  } catch {
    throw new Error(`Cloudflare cache purge returned invalid JSON${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`)
  }

  if (!body || body.success !== true) {
    throw new Error(`Cloudflare cache purge did not report success${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`)
  }
}

export async function purgePublicReadCacheTags(input: {
  env: Env
  tags: string[]
  fetcher?: typeof fetch
}): Promise<void> {
  if (input.tags.length === 0) {
    return
  }

  const results = await Promise.allSettled([
    purgeWorkersCacheTags({ env: input.env, tags: input.tags }),
    purgeZoneCacheTags({ env: input.env, tags: input.tags, fetcher: input.fetcher }),
  ])
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason)

  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Workers and zone cache purges both failed")
  }
}

async function capturePublicReadCachePurgeFailure(input: {
  env: Env
  error: unknown
  postId?: string | null
  communityId?: string | null
  tags: string[]
  captureException?: CaptureException
  fetcher?: typeof fetch
}): Promise<void> {
  console.error("[public-read-cache] failed to purge public read cache tags", {
    post_id: input.postId ?? null,
    community_id: input.communityId ?? null,
    tags: input.tags,
    error: input.error instanceof Error ? input.error.message : String(input.error),
  })

  await sendPublicReadCachePurgeFailureOpsAlert({
    env: input.env,
    error: input.error,
    postId: input.postId,
    communityId: input.communityId,
    tags: input.tags,
  })

  const sentryDsn = (input.env as { SENTRY_DSN?: string }).SENTRY_DSN
  if (!sentryDsn) {
    return
  }

  if (input.captureException) {
    input.captureException(input.error, {
      level: "error",
      tags: {
        component: "public_read_cache",
        operation: "purge",
      },
      extra: {
        post_id: input.postId ?? null,
        community_id: input.communityId ?? null,
        cache_tags: input.tags,
      },
    })
    return
  }

  await sendSentryPurgeFailureEvent({
    dsn: sentryDsn,
    environment: input.env.ENVIRONMENT ?? "production",
    error: input.error,
    postId: input.postId,
    communityId: input.communityId,
    tags: input.tags,
    fetcher: input.fetcher,
  })
}

async function sendSentryPurgeFailureEvent(input: {
  dsn: string
  environment: string
  error: unknown
  postId?: string | null
  communityId?: string | null
  tags: string[]
  fetcher?: typeof fetch
}): Promise<void> {
  const endpoint = sentryEnvelopeEndpoint(input.dsn)
  if (!endpoint) {
    return
  }

  const error = input.error instanceof Error ? input.error : new Error(String(input.error))
  const eventId = crypto.randomUUID().replace(/-/g, "")
  const now = new Date().toISOString()
  const envelope = [
    JSON.stringify({ dsn: input.dsn, event_id: eventId, sent_at: now }),
    JSON.stringify({ type: "event" }),
    JSON.stringify({
      event_id: eventId,
      timestamp: now,
      platform: "javascript",
      level: "error",
      message: "Public read cache purge failed",
      environment: input.environment,
      tags: {
        component: "public_read_cache",
        operation: "purge",
      },
      extra: {
        post_id: input.postId ?? null,
        community_id: input.communityId ?? null,
        cache_tags: input.tags,
      },
      exception: {
        values: [{
          type: error.name,
          value: error.message,
          stacktrace: error.stack ? { frames: [{ function: error.stack.slice(0, 500) }] } : undefined,
        }],
      },
    }),
  ].join("\n")

  const response = await (input.fetcher ?? fetch)(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-sentry-envelope" },
    body: envelope,
  }).catch((error) => {
    console.error("[public-read-cache] failed to report purge failure to Sentry", error)
    return null
  })

  if (response && !response.ok) {
    console.error("[public-read-cache] Sentry purge failure report was rejected", {
      status: response.status,
    })
  }
}

async function sendPublicReadCachePurgeFailureOpsAlert(input: {
  env: Env
  error: unknown
  postId?: string | null
  communityId?: string | null
  tags: string[]
}): Promise<void> {
  const alert: OpsAlert = {
    key: "public_read_cache:purge_failed",
    severity: "high",
    title: "Public read cache purge failed",
    count: 1,
    community_ids: input.communityId ? [input.communityId] : [],
    details: {
      post_id: input.postId ?? null,
      community_id: input.communityId ?? null,
      cache_tags: input.tags,
      error: input.error instanceof Error ? input.error.message : String(input.error),
    },
  }

  const delivery = await sendOpsAlerts(input.env, [alert]).catch((error) => {
    console.error("[public-read-cache] failed to send purge failure ops alert", error)
    return null
  })
  if (delivery && !delivery.delivered) {
    console.error("[public-read-cache] purge failure ops alert was not delivered", {
      sink: delivery.sink,
    })
  }
}

function sentryEnvelopeEndpoint(dsn: string): string | null {
  try {
    const url = new URL(dsn)
    const pathParts = url.pathname.split("/").filter(Boolean)
    const projectId = pathParts.pop()
    if (!projectId) {
      return null
    }
    const prefix = pathParts.length > 0 ? `/${pathParts.join("/")}` : ""
    return `${url.origin}${prefix}/api/${projectId}/envelope/`
  } catch {
    return null
  }
}

export function schedulePublicPostCachePurge(input: PublicPostCachePurgeInput): Promise<void> {
  const tags = publicPostCacheTags(input)
  return schedulePublicReadCachePurge({ ...input, tags })
}

export function schedulePublicCommunityCachePurge(input: PublicCommunityCachePurgeInput): Promise<void> {
  const tags = publicCommunityCacheTags(input.communityId)
  return schedulePublicReadCachePurge({ ...input, tags })
}

function schedulePublicReadCachePurge(input: {
  env: Env
  tags: string[]
  postId?: string | null
  communityId?: string | null
  waitUntil?: WaitUntil
  captureException?: CaptureException
  fetcher?: typeof fetch
}): Promise<void> {
  const task = purgePublicReadCacheTags({
    env: input.env,
    tags: input.tags,
    fetcher: input.fetcher,
  }).catch(async (error) => {
    await capturePublicReadCachePurgeFailure({
      env: input.env,
      error,
      postId: input.postId ?? null,
      communityId: input.communityId,
      tags: input.tags,
      captureException: input.captureException,
      fetcher: input.fetcher,
    })
  })

  if (input.waitUntil) {
    input.waitUntil(task)
    return Promise.resolve()
  }
  return task
}
