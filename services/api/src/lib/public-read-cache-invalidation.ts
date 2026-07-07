import type { Env } from "../env"
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

export async function purgePublicReadCacheTags(input: {
  env: Env
  tags: string[]
  fetcher?: typeof fetch
}): Promise<void> {
  const config = cloudflareCachePurgeConfig(input.env)
  if (!config || input.tags.length === 0) {
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

async function capturePublicReadCachePurgeFailure(input: {
  env: Env
  error: unknown
  postId: string
  communityId?: string | null
  tags: string[]
  captureException?: CaptureException
  fetcher?: typeof fetch
}): Promise<void> {
  console.error("[public-read-cache] failed to purge public post cache tags", {
    post_id: input.postId,
    community_id: input.communityId ?? null,
    tags: input.tags,
    error: input.error instanceof Error ? input.error.message : String(input.error),
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
        post_id: input.postId,
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
  postId: string
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
        post_id: input.postId,
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
  const task = purgePublicReadCacheTags({
    env: input.env,
    tags,
    fetcher: input.fetcher,
  }).catch(async (error) => {
    await capturePublicReadCachePurgeFailure({
      env: input.env,
      error,
      postId: input.postId,
      communityId: input.communityId,
      tags,
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
