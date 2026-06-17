import type { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { resolveCommunityKaraokeScoringPolicy } from "../lib/communities/community-karaoke-policy-service"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import { getProfileRepository, getUserRepository } from "../lib/auth/repositories"
import { badRequestError, HttpError, notFoundError } from "../lib/errors"
import { issueKaraokeGatewayToken } from "../lib/karaoke/gateway-token"
import {
  claimKaraokeSessionCreation,
  failKaraokeSessionCreation,
  finalizeKaraokeSessionCreation,
  rotateKaraokeGatewayClaims,
} from "../lib/karaoke/session-creation-repository"
import { createKaraokeSession } from "../lib/karaoke/session-creation-service"
import { getPostKaraokePayload } from "../lib/posts/post-karaoke-service"
import { decodePublicPostId } from "../lib/public-ids"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { getResolvedCommunityRouteContext } from "./communities-route-helpers"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? ""
  if (!UUID_PATTERN.test(key)) {
    throw badRequestError("Idempotency-Key must be a UUID")
  }
  return key
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

export function registerCommunityKaraokeSessionRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/:communityId/posts/:postId/karaoke", async (c) => {
    const communityRepository = getCommunityRepository(c.env)
    const communityId = await resolveCommunityIdentifier(
      communityRepository,
      c.req.param("communityId")?.trim() ?? "",
    )
    if (!communityId) {
      throw notFoundError("Post not found")
    }
    const payload = await getPostKaraokePayload({
      communityId,
      communityRepository,
      env: c.env,
      locale: c.req.query("locale") ?? null,
      postId: decodePublicPostId(c.req.param("postId")),
      profileRepository: getProfileRepository(c.env),
      userRepository: getUserRepository(c.env),
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
          return { status: response.status }
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
