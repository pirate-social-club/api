import type { Env, PublicReadCacheRpc } from "../env"
import { purgePublicReadCacheTags } from "./public-read-cache-invalidation"

export const PUBLIC_READ_CACHE_CANARY_HEADER = "x-pirate-public-read-cache-canary"
export const PUBLIC_READ_CACHE_CANARY_TAG = "public-read-cache-canary"

const DEFAULT_INTERVAL_MINUTES = 15
const MAX_INTERVAL_MINUTES = 24 * 60
const CANARY_ORIGIN = "https://public-read-cache-canary.internal"
const EVICTION_POLL_INTERVAL_MS = 250
const EVICTION_POLL_ATTEMPTS = 20

type CanaryPayload = {
  value: string
}

type FetchablePublicReadCache = PublicReadCacheRpc & {
  fetch(request: Request): Promise<Response>
}

function hasFetch(entrypoint: PublicReadCacheRpc | undefined): entrypoint is FetchablePublicReadCache {
  return typeof entrypoint?.fetch === "function"
}

function configuredIntervalMinutes(env: Env): number {
  const parsed = Number(env.PUBLIC_READ_CACHE_CANARY_INTERVAL_MINUTES)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_INTERVAL_MINUTES
  return Math.min(MAX_INTERVAL_MINUTES, Math.trunc(parsed))
}

export function shouldRunPublicReadCacheCanary(env: Env, scheduledTime: number): boolean {
  if (String(env.PUBLIC_READ_CACHE_CANARY_ENABLED ?? "").trim().toLowerCase() !== "true") return false
  if (!hasFetch(env.PUBLIC_READ_CACHE)) return false
  const scheduledMinute = Math.floor(scheduledTime / 60_000)
  return scheduledMinute % configuredIntervalMinutes(env) === 0
}

async function readCanary(input: {
  entrypoint: FetchablePublicReadCache
  runId: string
  value: string
}): Promise<string> {
  const response = await input.entrypoint.fetch(new Request(
    `${CANARY_ORIGIN}/public-posts/__cache-canary?run=${encodeURIComponent(input.runId)}`,
    { headers: { [PUBLIC_READ_CACHE_CANARY_HEADER]: input.value } },
  ))
  if (!response.ok) {
    throw new Error(`Public read cache canary returned HTTP ${response.status}`)
  }
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== "object" || typeof (payload as Partial<CanaryPayload>).value !== "string") {
    throw new Error("Public read cache canary returned an invalid payload")
  }
  return (payload as CanaryPayload).value
}

export async function runPublicReadCacheCanary(env: Env, dependencies?: {
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<{
  warmed: true
  evicted: true
  propagation_ms: number
}> {
  const entrypoint = env.PUBLIC_READ_CACHE
  if (!hasFetch(entrypoint)) {
    throw new Error("PUBLIC_READ_CACHE fetch binding is required for the public read cache canary")
  }

  const runId = crypto.randomUUID()
  const before = `before:${crypto.randomUUID()}`
  const after = `after:${crypto.randomUUID()}`

  const initial = await readCanary({ entrypoint, runId, value: before })
  if (initial !== before) {
    throw new Error("Public read cache canary initial read did not reach the current origin response")
  }

  const cached = await readCanary({ entrypoint, runId, value: after })
  if (cached !== before) {
    throw new Error("Public read cache canary could not observe a warmed cache entry")
  }

  await purgePublicReadCacheTags({ env, tags: [PUBLIC_READ_CACHE_CANARY_TAG] })

  const now = dependencies?.now ?? Date.now
  const sleep = dependencies?.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  }))
  const purgeCompletedAt = now()
  for (let attempt = 0; attempt <= EVICTION_POLL_ATTEMPTS; attempt += 1) {
    const refreshed = await readCanary({ entrypoint, runId, value: after })
    if (refreshed === after) {
      return { warmed: true, evicted: true, propagation_ms: now() - purgeCompletedAt }
    }
    if (attempt < EVICTION_POLL_ATTEMPTS) {
      await sleep(EVICTION_POLL_INTERVAL_MS)
    }
  }

  throw new Error("Public read cache purge reported success but did not evict the warmed entry within 5 seconds")
}
