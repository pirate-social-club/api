import { Hono, type Context } from "hono"
import {
  createCommunityListing,
  createCommunityPurchaseQuote,
  failCommunityPurchase,
  fetchCommunityAssetContent,
  getCommunityAsset,
  getCommunityMoneyPolicy,
  getCommunityPricingPolicy,
  getCommunityListing,
  getCommunityPurchase,
  listCommunityPurchaseSettlementEffects,
  listDerivativeSources,
  listCommunityListings,
  listCommunityPurchases,
  preflightCommunityPurchaseQuote,
  resolveCommunityAssetAccess,
  settleCommunityPurchase,
  updateCommunityMoneyPolicy,
  updateCommunityPricingPolicy,
  updateCommunityListing,
  type DerivativeSourceScope,
} from "../lib/communities/commerce/service"
import { getCommunity } from "../lib/communities/membership/community-read-service"
import { requireLiveCommunity } from "../lib/communities/community-status"
import { badRequestError } from "../lib/errors"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import type {
  CommunityPurchaseQuotePreflightRequest,
  CommunityPurchaseQuoteRequest,
  CommunityPurchaseSettlementFailureRequest,
  CommunityPurchaseSettlementRequest,
  CreateCommunityListingRequest,
  DerivativeSourceKind,
  UpdateCommunityListingRequest,
  UpdateCommunityMoneyPolicyRequest,
  UpdateCommunityPricingPolicyRequest,
} from "../types"
import { emitRoyaltyEarnedBatch } from "../lib/notifications/notification-emitters"
import { recoverRequestedLockedAssetDelivery } from "../lib/communities/jobs/locked-asset-delivery-recovery"
import type { CommunityJobRepository } from "../lib/communities/jobs/runner-types"
import { withRequestControlPlaneClients } from "../lib/runtime-deps"
import {
  decodePublicAssetId,
  decodePublicListingId,
  decodePublicPurchaseId,
} from "../lib/public-ids"

const DEFAULT_COMMERCE_LIST_LIMIT = 25
const MAX_COMMERCE_LIST_LIMIT = 100

function getWaitUntil(c: Context): ((promise: Promise<void>) => void) | undefined {
  try {
    const executionCtx = c.executionCtx
    return (promise) => executionCtx.waitUntil(promise)
  } catch {
    return undefined
  }
}

function commerceListLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_COMMERCE_LIST_LIMIT
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw badRequestError("Invalid limit")
  }
  return Math.min(parsed, MAX_COMMERCE_LIST_LIMIT)
}

function derivativeSourceKind(value: string | undefined): DerivativeSourceKind | null {
  if (value === undefined || value.trim() === "") {
    return null
  }
  if (value === "song" || value === "video") {
    return value
  }
  if (value === "live") {
    return "song"
  }
  throw badRequestError("Invalid derivative source kind")
}

function derivativeSourceScope(value: string | undefined): DerivativeSourceScope {
  if (value === undefined || value.trim() === "") {
    return "community"
  }
  if (value === "community" || value === "global") {
    return value
  }
  throw badRequestError("Invalid derivative source scope")
}

export function registerCommunityCommerceRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/:communityId/money-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    await getCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      repository: communityRepository,
    })
    const result = await getCommunityMoneyPolicy({
      env: c.env,
      communityId,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/money-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityMoneyPolicyRequest>(c, "Invalid community money policy payload")
    const result = await updateCommunityMoneyPolicy({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/pricing-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    await getCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      repository: communityRepository,
    })
    const result = await getCommunityPricingPolicy({
      env: c.env,
      communityId,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/pricing-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityPricingPolicyRequest>(c, "Invalid community pricing policy payload")
    const result = await updateCommunityPricingPolicy({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/derivative-sources", async (c) => {
    const { actor, communityId, communityRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const scope = derivativeSourceScope(c.req.query("scope"))
    const result = await listDerivativeSources({
      env: c.env,
      userId: actor.userId,
      scope,
      communityId,
      kind: derivativeSourceKind(c.req.query("kind")),
      query: c.req.query("q") ?? null,
      limit: commerceListLimit(c.req.query("limit")),
      communityRepository,
      profileRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/assets/:assetId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const assetId = decodePublicAssetId(c.req.param("assetId"))
    const result = await getCommunityAsset({
      env: c.env,
      userId: actor.userId,
      communityId,
      assetId,
      communityRepository,
    })
    if (result.locked_delivery_status === "requested") {
      getWaitUntil(c)?.(withRequestControlPlaneClients(async () => {
        try {
          await recoverRequestedLockedAssetDelivery({
            env: c.env,
            communityId,
            assetId,
            communityRepository: communityRepository as unknown as CommunityJobRepository,
          })
        } catch (error) {
          console.error("[commerce] requested asset delivery recovery failed (fail-soft)", {
            community_id: communityId,
            asset_id: assetId,
            error,
          })
        }
      }))
    }
    return c.json(result, 200)
  })

  communities.get("/:communityId/assets/:assetId/access", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const result = await resolveCommunityAssetAccess({
      env: c.env,
      userId: actor.userId,
      communityId,
      assetId: decodePublicAssetId(c.req.param("assetId")),
      communityRepository,
      userRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/assets/:assetId/content", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    return await fetchCommunityAssetContent({
      env: c.env,
      userId: actor.userId,
      communityId,
      assetId: decodePublicAssetId(c.req.param("assetId")),
      communityRepository,
      userRepository,
    })
  })

  communities.get("/:communityId/listings", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityListings({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
      cursor: c.req.query("cursor") ?? null,
      limit: commerceListLimit(c.req.query("limit")),
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/listings", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateCommunityListingRequest>(c, "Invalid community listing payload")
    const result = await createCommunityListing({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
      userRepository,
    })
    return c.json(result, 201)
  })

  communities.get("/:communityId/listings/:listingId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityListing({
      env: c.env,
      userId: actor.userId,
      communityId,
      listingId: decodePublicListingId(c.req.param("listingId")),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/listings/:listingId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityListingRequest>(c, "Invalid community listing update payload")
    const result = await updateCommunityListing({
      env: c.env,
      userId: actor.userId,
      communityId,
      listingId: decodePublicListingId(c.req.param("listingId")),
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/purchases", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityPurchases({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
      cursor: c.req.query("cursor") ?? null,
      limit: commerceListLimit(c.req.query("limit")),
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/purchases/:purchaseId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityPurchase({
      env: c.env,
      userId: actor.userId,
      communityId,
      purchaseId: decodePublicPurchaseId(c.req.param("purchaseId")),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/purchases/:purchaseId/settlement-effects", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityPurchaseSettlementEffects({
      env: c.env,
      userId: actor.userId,
      communityId,
      purchaseId: decodePublicPurchaseId(c.req.param("purchaseId")),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/purchase-quote-preflight", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    await requireLiveCommunity(communityRepository, communityId)
    const body = await requireJsonBody<CommunityPurchaseQuotePreflightRequest>(c, "Invalid purchase quote preflight payload")
    const result = await preflightCommunityPurchaseQuote({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
      userRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/purchase-quotes", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    await requireLiveCommunity(communityRepository, communityId)
    const body = await requireJsonBody<CommunityPurchaseQuoteRequest>(c, "Invalid purchase quote payload")
    const result = await createCommunityPurchaseQuote({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
      userRepository,
    })
    return c.json(result, 201)
  })

  communities.post("/:communityId/purchase-settlements", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    await requireLiveCommunity(communityRepository, communityId)
    const body = await requireJsonBody<CommunityPurchaseSettlementRequest>(c, "Invalid purchase settlement payload")
    const result = await settleCommunityPurchase({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
      userRepository,
    })
    if (result.royaltyEarningEvents.length > 0) {
      try {
        await emitRoyaltyEarnedBatch({
          env: c.env,
          buyerUserId: actor.userId,
          events: result.royaltyEarningEvents,
        })
      } catch (error) {
        console.warn("[settlement] royalty notification emission failed", error)
      }
    }
    return c.json(result.settlement, 201)
  })

  communities.post("/:communityId/fail-purchase-settlement", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityPurchaseSettlementFailureRequest>(c, "Invalid purchase settlement failure payload")
    const result = await failCommunityPurchase({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })
}
