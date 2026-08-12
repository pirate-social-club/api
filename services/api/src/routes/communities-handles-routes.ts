import { Hono, type Context } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  claimCommunityHandle,
} from "../lib/communities/handles/handle-claim-service"
import { quoteCommunityHandle } from "../lib/communities/handles/handle-quote-service"
import {
  reserveCommunityHandle,
  revokeCommunityHandle,
} from "../lib/communities/handles/handle-reservation-service"
import { updateCommunityHandlePolicy } from "../lib/communities/handles/handle-policy-service"
import {
  getCommunityHandlePolicy,
  getCommunityHandleStatus,
  getMyCommunityHandle,
  listCommunityHandles,
} from "../lib/communities/handles/handle-read-service"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import type {
  CommunityHandleClaimRequest,
  CommunityHandleQuoteRequest,
  CommunityHandleReserveRequest,
  CommunityHandleRevokeRequest,
  UpdateCommunityHandlePolicyRequest,
} from "../types"
import { decodePublicNamespaceVerificationId } from "../lib/public-ids"
import { badRequestError } from "../lib/errors"
import { enforceRateLimit } from "../lib/rate-limit"
import { schedulePublicCommunityCachePurge } from "../lib/public-read-cache-invalidation"

function getWaitUntil(c: Context): ((promise: Promise<void>) => void) | undefined {
  try {
    const executionCtx = c.executionCtx
    return (promise) => executionCtx.waitUntil(promise)
  } catch {
    return undefined
  }
}

async function purgeCommunityHandleBylines(c: Context<AuthenticatedEnv>, communityId: string): Promise<void> {
  await schedulePublicCommunityCachePurge({
    env: c.env,
    communityId,
    waitUntil: getWaitUntil(c),
  })
}

function namespaceVerificationSelector(value: string | undefined): string | null {
  const publicId = value?.trim() || null
  if (!publicId) return null
  const decoded = decodePublicNamespaceVerificationId(publicId)
  if (!decoded) throw badRequestError("Invalid namespace_verification")
  return decoded
}

export function registerCommunityHandleRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/:communityId/handles/me", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getMyCommunityHandle({
      env: c.env,
      userId: actor.userId,
      communityId,
      namespaceVerificationId: namespaceVerificationSelector(c.req.query("namespace_verification")),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/handles/status", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityHandleStatus({
      env: c.env,
      userId: actor.userId,
      communityId,
      namespaceVerificationId: namespaceVerificationSelector(c.req.query("namespace_verification")),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/handle-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityHandlePolicy({
      env: c.env,
      userId: actor.userId,
      communityId,
      namespaceVerificationId: namespaceVerificationSelector(c.req.query("namespace_verification")),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/handles", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityHandles({
      env: c.env,
      userId: actor.userId,
      communityId,
      namespaceVerificationId: namespaceVerificationSelector(c.req.query("namespace_verification")),
      status: c.req.query("status"),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/handle-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityHandlePolicyRequest>(c, "Invalid community handle policy payload")
    const result = await updateCommunityHandlePolicy({
      env: c.env,
      userId: actor.userId,
      communityId,
      namespaceVerificationId: namespaceVerificationSelector(c.req.query("namespace_verification")),
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/handles/reserve", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityHandleReserveRequest>(c, "Invalid community handle reserve payload")
    const result = await reserveCommunityHandle({
      env: c.env,
      userId: actor.userId,
      communityId,
      namespaceVerificationId: namespaceVerificationSelector(c.req.query("namespace_verification")),
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/handles/quote", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    await enforceRateLimit(
      c.env.HANDLE_QUOTE_RATE_LIMITER,
      `community-handle-quote:${actor.userId}`,
      "Community handle quote rate limit exceeded",
      { scope: "community_handle_quote" },
    )
    const body = await requireJsonBody<CommunityHandleQuoteRequest>(c, "Invalid community handle quote payload")
    const namespaceVerificationId = namespaceVerificationSelector(body.namespace_verification ?? undefined)
    const result = await quoteCommunityHandle({
      env: c.env,
      userId: actor.userId,
      communityId,
      namespaceVerificationId,
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/handles/:handleId/revoke", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityHandleRevokeRequest>(c, "Invalid community handle revoke payload")
    const result = await revokeCommunityHandle({
      env: c.env,
      userId: actor.userId,
      communityId,
      handleId: c.req.param("handleId"),
      body,
      communityRepository,
    })
    await purgeCommunityHandleBylines(c, communityId)
    return c.json(result, 200)
  })

  communities.post("/:communityId/handles/claim", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    await enforceRateLimit(
      c.env.HANDLE_CLAIM_RATE_LIMITER,
      `community-handle-claim:${actor.userId}`,
      "Community handle claim rate limit exceeded",
      { scope: "community_handle_claim" },
    )
    const body = await requireJsonBody<CommunityHandleClaimRequest>(c, "Invalid community handle claim payload")
    const result = await claimCommunityHandle({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      userRepository,
      communityRepository,
    })
    await purgeCommunityHandleBylines(c, communityId)
    return c.json(result, 200)
  })
}
