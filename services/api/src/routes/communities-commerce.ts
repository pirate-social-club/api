import { Hono } from "hono"
import {
  fetchCommunityAssetContent,
  getCommunityAsset,
  resolveCommunityAssetAccess,
} from "../lib/communities/commerce/service"
import {
  getCommunityMoneyPolicy,
  getCommunityPricingPolicy,
  updateCommunityMoneyPolicy,
  updateCommunityPricingPolicy,
} from "../lib/communities/commerce/policy-service"
import {
  createCommunityListing,
  getCommunityListing,
  listCommunityListings,
  updateCommunityListing,
} from "../lib/communities/commerce/listing-service"
import {
  createCommunityPurchaseQuote,
  failCommunityPurchase,
  preflightCommunityPurchaseQuote,
} from "../lib/communities/commerce/quote-service"
import {
  getCommunityPurchase,
  listCommunityPurchases,
  settleCommunityPurchase,
} from "../lib/communities/commerce/settlement-service"
import { getCommunity } from "../lib/communities/membership/read-service"
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
  UpdateCommunityListingRequest,
  UpdateCommunityMoneyPolicyRequest,
  UpdateCommunityPricingPolicyRequest,
} from "../types"

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

  communities.put("/:communityId/money-policy", async (c) => {
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

  communities.put("/:communityId/pricing-policy", async (c) => {
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

  communities.get("/:communityId/assets/:assetId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityAsset({
      env: c.env,
      userId: actor.userId,
      communityId,
      assetId: c.req.param("assetId"),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/assets/:assetId/access", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const result = await resolveCommunityAssetAccess({
      env: c.env,
      userId: actor.userId,
      communityId,
      assetId: c.req.param("assetId"),
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
      assetId: c.req.param("assetId"),
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
      listingId: c.req.param("listingId"),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.patch("/:communityId/listings/:listingId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityListingRequest>(c, "Invalid community listing update payload")
    const result = await updateCommunityListing({
      env: c.env,
      userId: actor.userId,
      communityId,
      listingId: c.req.param("listingId"),
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
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/purchases/:purchaseId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityPurchase({
      env: c.env,
      userId: actor.userId,
      communityId,
      purchaseId: c.req.param("purchaseId"),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/purchase-quote-preflight", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
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
    const body = await requireJsonBody<CommunityPurchaseSettlementRequest>(c, "Invalid purchase settlement payload")
    const result = await settleCommunityPurchase({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
      userRepository,
    })
    return c.json(result, 201)
  })

  communities.post("/:communityId/purchase-settlements/fail", async (c) => {
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
