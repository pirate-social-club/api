import type { Hono } from "hono"
import type { Context } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import type { Env } from "../env"
import { resolveCommunityKaraokeScoringPolicy } from "../lib/communities/community-karaoke-policy-service"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import { isCommunityLive } from "../lib/communities/community-status"
import { getProfileRepository, getUserRepository } from "../lib/auth/repositories"
import { badRequestError, HttpError, notFoundError } from "../lib/errors"
import { issueKaraokeGatewayToken } from "../lib/karaoke/gateway-token"
import { getPostKaraokeLeaderboard } from "../lib/karaoke/karaoke-attempt-service"
import {
  claimKaraokeSessionCreation,
  failKaraokeSessionCreation,
  finalizeKaraokeSessionCreation,
  rotateKaraokeGatewayClaims,
} from "../lib/karaoke/session-creation-repository"
import { createKaraokeSession } from "../lib/karaoke/session-creation-service"
import { getPostKaraokePayload, loadPublicPostKaraokePayloadCacheContext } from "../lib/posts/post-karaoke-service"
import { decodePublicPostId } from "../lib/public-ids"
import { getControlPlaneClient } from "../lib/runtime-deps"
import {
  PUBLIC_READ_CACHE_CONTROL,
  PUBLIC_READ_CACHE_FRESH_SECONDS,
  PUBLIC_READ_CDN_CACHE_CONTROL,
  setPublicReadCacheHeaders,
} from "./cache-headers"
import { getResolvedCommunityRouteContext } from "./communities-route-helpers"
import { createServerTimingRecorder } from "./server-timing"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? ""
  if (!UUID_PATTERN.test(key)) {
    throw badRequestError("Idempotency-Key must be a UUID")
  }
  return key
}

function parseLeaderboardLimit(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw badRequestError("limit must be an integer between 1 and 100")
  }
  return limit
}

function requireGatewaySigningKey(value: string | undefined): string {
  const key = value?.trim() ?? ""
  if (key.length < 32) {
    throw new HttpError(503, "karaoke_runtime_unavailable", "Karaoke gateway signing is unavailable", true)
  }
  return key
}

function requestId(value: string | undefined): string {
  const candidate = value?.trim()
  return candidate && candidate.length <= 256 ? candidate : crypto.randomUUID()
}

function websocketBaseUrl(requestUrl: string, sessionId: string): string {
  const url = new URL(requestUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = `/karaoke/sessions/${encodeURIComponent(sessionId)}/websocket`
  url.search = ""
  url.hash = ""
  return url.toString()
}

async function getWorkerCache(): Promise<Cache | null> {
  return typeof caches === "undefined" ? null : await caches.open("public-karaoke-payloads")
}

function buildPublicKaraokePayloadCacheKey(requestUrl: string, input: {
  communityId: string
  locale: string | null
  postId: string
}): Request {
  const url = new URL(requestUrl)
  url.pathname = `/__cache/public-karaoke/${encodeURIComponent(input.communityId)}/${encodeURIComponent(input.postId)}`
  url.search = ""
  if (input.locale) {
    url.searchParams.set("locale", input.locale)
  }
  url.hash = ""
  return new Request(url.toString(), {
    headers: { accept: "application/json" },
    method: "GET",
  })
}

function responseFromCachedKaraokePayload(response: Response, serverTiming: string | null): Response {
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", PUBLIC_READ_CACHE_CONTROL)
  headers.set("CDN-Cache-Control", PUBLIC_READ_CDN_CACHE_CONTROL)
  headers.set("Cloudflare-CDN-Cache-Control", PUBLIC_READ_CDN_CACHE_CONTROL)
  headers.set("Vary", "Accept")
  headers.set("X-Pirate-Worker-Cache", "HIT")
  if (serverTiming) {
    headers.set("Server-Timing", serverTiming)
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

function responseForKaraokePayloadCache(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", `public, max-age=${PUBLIC_READ_CACHE_FRESH_SECONDS}`)
  headers.set("X-Pirate-Worker-Cache", "MISS")
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

const defaultKaraokePayloadRouteDeps = {
  getCommunityRepository,
  getPostKaraokePayload,
  getProfileRepository,
  getUserRepository,
  getWorkerCache,
  loadPublicPostKaraokePayloadCacheContext,
  resolveCommunityIdentifier,
}

let karaokePayloadRouteDeps = defaultKaraokePayloadRouteDeps

export function setKaraokePayloadRouteDepsForTests(
  overrides: Partial<typeof defaultKaraokePayloadRouteDeps>,
): () => void {
  const previous = karaokePayloadRouteDeps
  karaokePayloadRouteDeps = {
    ...karaokePayloadRouteDeps,
    ...overrides,
  }
  return () => {
    karaokePayloadRouteDeps = previous
  }
}

export async function handlePublicKaraokePayloadRequest<E extends { Bindings: Env }>(
  c: Context<E>,
  input: {
    communityId: string
    postId: string
  },
): Promise<Response> {
  const timing = createServerTimingRecorder(c)
  const communityId = input.communityId
  const postId = input.postId
  const locale = c.req.query("locale") ?? null
  const communityRepository = karaokePayloadRouteDeps.getCommunityRepository(c.env)
  const cacheContext = await timing.time("cache_eligibility", () => karaokePayloadRouteDeps.loadPublicPostKaraokePayloadCacheContext({
    communityId,
    communityRepository,
    env: c.env,
    postId,
    recordTiming: timing.record,
    userRepository: karaokePayloadRouteDeps.getUserRepository(c.env),
  }))
  const workerCache = cacheContext.cacheable ? await timing.time("worker_cache_open", karaokePayloadRouteDeps.getWorkerCache) : null
  const cacheKey = workerCache
    ? buildPublicKaraokePayloadCacheKey(c.req.url, { communityId, locale, postId })
    : null
  const cached = cacheKey ? await timing.time("worker_cache_match", () => workerCache?.match(cacheKey) ?? Promise.resolve(undefined)) : undefined
  if (cached) {
    setPublicReadCacheHeaders(c, { vary: ["Accept"] })
    timing.writeHeader()
    return responseFromCachedKaraokePayload(cached, c.res.headers.get("Server-Timing"))
  }

  const payload = await timing.time("karaoke_payload", () => karaokePayloadRouteDeps.getPostKaraokePayload({
    communityId,
    communityRepository,
    env: c.env,
    locale,
    postContext: cacheContext.postContext,
    postId,
    profileRepository: karaokePayloadRouteDeps.getProfileRepository(c.env),
    recordTiming: timing.record,
    userRepository: karaokePayloadRouteDeps.getUserRepository(c.env),
  }))
  setPublicReadCacheHeaders(c, { vary: ["Accept"] })
  timing.writeHeader()
  const response = c.json(payload, 200)
  response.headers.set("X-Pirate-Worker-Cache", cacheContext.cacheable ? "MISS" : "BYPASS")
  if (cacheKey && workerCache) {
    c.executionCtx.waitUntil(workerCache.put(cacheKey, responseForKaraokePayloadCache(response.clone())))
  }
  return response
}

export async function handlePublicPostKaraokePayloadRequest<E extends { Bindings: Env }>(
  c: Context<E>,
  input: {
    postId: string
  },
): Promise<Response> {
  const communityRepository = karaokePayloadRouteDeps.getCommunityRepository(c.env)
  const projection = await communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection) {
    throw notFoundError("Post not found")
  }
  const communityRow = await communityRepository.getCommunityById(projection.community_id)
  if (!isCommunityLive(communityRow)) {
    throw notFoundError("Post not found")
  }
  return await handlePublicKaraokePayloadRequest(c, {
    communityId: projection.community_id,
    postId: input.postId,
  })
}

export function registerCommunityKaraokeSessionRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/:communityId/posts/:postId/karaoke", async (c) => {
    const timing = createServerTimingRecorder(c)
    const communityRepository = karaokePayloadRouteDeps.getCommunityRepository(c.env)
    const communityId = await timing.time("resolve_community", () => karaokePayloadRouteDeps.resolveCommunityIdentifier(
      communityRepository,
      c.req.param("communityId")?.trim() ?? "",
    ))
    if (!communityId) {
      throw notFoundError("Post not found")
    }
    const postId = decodePublicPostId(c.req.param("postId"))
    return await handlePublicKaraokePayloadRequest(c, { communityId, postId })
  })

  communities.get("/:communityId/posts/:postId/karaoke/leaderboard", async (c) => {
    const { actor, communityId, communityRepository, profileRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const postId = decodePublicPostId(c.req.param("postId"))
    const url = new URL(c.req.url)
    const payload = await getPostKaraokeLeaderboard({
      actor,
      communityId,
      communityRepository,
      env: c.env,
      limit: parseLeaderboardLimit(url.searchParams.get("limit") ?? undefined),
      postId,
      profileRepository,
      scope: url.searchParams.get("scope"),
      userRepository,
    })
    return c.json(payload, 200)
  })

  communities.post("/:communityId/posts/:postId/karaoke/sessions", async (c) => {
    const actor = c.get("actor")
    if (actor.authType === "admin" || actor.authType === "agent_delegated") {
      throw new HttpError(403, "karaoke_session_actor_not_allowed", "Karaoke sessions require a user or device actor")
    }
    const namespace = c.env.KARAOKE_SESSION_RUNTIME
    if (!namespace) {
      throw new HttpError(503, "karaoke_runtime_unavailable", "Karaoke runtime is unavailable", true)
    }
    const signingKey = requireGatewaySigningKey(c.env.KARAOKE_GATEWAY_SIGNING_KEY)
    const correlationId = requestId(c.req.header("x-request-id"))
    const idempotencyKey = requireIdempotencyKey(c.req.header("idempotency-key"))
    const postId = decodePublicPostId(c.req.param("postId"))
    const client = getControlPlaneClient(c.env)

    const { communityId, communityRepository, profileRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const result = await createKaraokeSession({
      communityId,
      idempotencyKey,
      postId,
      subjectUserId: actor.userId,
      deps: {
        claim: (input) => claimKaraokeSessionCreation({ client, ...input }),
        fail: (input) => failKaraokeSessionCreation({ client, ...input }),
        finalize: (input) => finalizeKaraokeSessionCreation({ client, ...input }),
        initializeRuntime: async (input) => {
          const stub = namespace.get(namespace.idFromName(input.sessionId))
          const response = await stub.fetch("https://karaoke-runtime.internal/init", {
            body: JSON.stringify(input),
            headers: { "content-type": "application/json" },
            method: "POST",
          })
          const body = await response.json().catch(() => null) as { error?: unknown } | null
          return {
            errorCode: typeof body?.error === "string" ? body.error : null,
            status: response.status,
          }
        },
        issueToken: ({ claims }) => issueKaraokeGatewayToken({ claims, secret: signingKey }),
        loadPayload: () => getPostKaraokePayload({
          actor,
          communityId,
          communityRepository,
          env: c.env,
          postId,
          profileRepository,
          userRepository,
        }),
        nowMs: () => Date.now(),
        randomUUID: () => crypto.randomUUID(),
        resolveScoringPolicy: () => resolveCommunityKaraokeScoringPolicy({
          communityId,
          communityRepository,
          env: c.env,
        }),
        rotateClaims: (input) => rotateKaraokeGatewayClaims({ client, ...input }),
        websocketBaseUrl: (sessionId) => websocketBaseUrl(c.req.url, sessionId),
      },
    })

    c.header("X-Request-Id", correlationId)
    return c.json(result, 201)
  })
}
