import { Hono } from "hono"
import { getUserRepository } from "../lib/auth/repositories"
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
  listCommunityListings,
  listCommunityPurchases,
  preflightCommunityPurchaseQuote,
  resolveCommunityAssetAccess,
  settleCommunityPurchase,
  updateCommunityMoneyPolicy,
  updateCommunityPricingPolicy,
  updateCommunityListing,
} from "../lib/communities/community-commerce-service"
import { getCommunity } from "../lib/communities/community-service"
import { getCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { badRequestError } from "../lib/errors"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
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
    const actor = c.get("actor")
    await getCommunity({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      repository: getCommunityRepository(c.env),
    })
    const result = await getCommunityMoneyPolicy({
      env: c.env,
      communityId: c.req.param("communityId"),
    })
    return c.json(result, 200)
  })

  communities.put("/:communityId/money-policy", async (c) => {
    const actor = c.get("actor")
    const body = await c.req.json<UpdateCommunityMoneyPolicyRequest>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid community money policy payload")
    }
    const result = await updateCommunityMoneyPolicy({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      body,
      communityRepository: getCommunityRepository(c.env),
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/pricing-policy", async (c) => {
    const actor = c.get("actor")
    await getCommunity({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      repository: getCommunityRepository(c.env),
    })
    const result = await getCommunityPricingPolicy({
      env: c.env,
      communityId: c.req.param("communityId"),
    })
    return c.json(result, 200)
  })

  communities.put("/:communityId/pricing-policy", async (c) => {
    const actor = c.get("actor")
    const body = await c.req.json<UpdateCommunityPricingPolicyRequest>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid community pricing policy payload")
    }
    const result = await updateCommunityPricingPolicy({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      body,
      communityRepository: getCommunityRepository(c.env),
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/assets/:assetId", async (c) => {
    const actor = c.get("actor")
    const result = await getCommunityAsset({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      assetId: c.req.param("assetId"),
      communityRepository: getCommunityRepository(c.env),
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/assets/:assetId/access", async (c) => {
    const actor = c.get("actor")
    const result = await resolveCommunityAssetAccess({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      assetId: c.req.param("assetId"),
      communityRepository: getCommunityRepository(c.env),
      userRepository: getUserRepository(c.env),
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/assets/:assetId/content", async (c) => {
    const actor = c.get("actor")
    return await fetchCommunityAssetContent({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      assetId: c.req.param("assetId"),
      communityRepository: getCommunityRepository(c.env),
      userRepository: getUserRepository(c.env),
    })
  })

  communities.get("/:communityId/listings", async (c) => {
    const actor = c.get("actor")
    const result = await listCommunityListings({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      communityRepository: getCommunityRepository(c.env),
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/listings", async (c) => {
    const actor = c.get("actor")
    const body = await c.req.json<CreateCommunityListingRequest>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid community listing payload")
    }
    const result = await createCommunityListing({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      body,
      communityRepository: getCommunityRepository(c.env),
      userRepository: getUserRepository(c.env),
    })
    return c.json(result, 201)
  })

  communities.get("/:communityId/listings/:listingId", async (c) => {
    const actor = c.get("actor")
    const result = await getCommunityListing({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      listingId: c.req.param("listingId"),
      communityRepository: getCommunityRepository(c.env),
    })
    return c.json(result, 200)
  })

  communities.patch("/:communityId/listings/:listingId", async (c) => {
    const actor = c.get("actor")
    const body = await c.req.json<UpdateCommunityListingRequest>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid community listing update payload")
    }
    const result = await updateCommunityListing({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      listingId: c.req.param("listingId"),
      body,
      communityRepository: getCommunityRepository(c.env),
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/purchases", async (c) => {
    const actor = c.get("actor")
    const result = await listCommunityPurchases({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      communityRepository: getCommunityRepository(c.env),
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/purchases/:purchaseId", async (c) => {
    const actor = c.get("actor")
    const result = await getCommunityPurchase({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      purchaseId: c.req.param("purchaseId"),
      communityRepository: getCommunityRepository(c.env),
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/purchase-quote-preflight", async (c) => {
    const actor = c.get("actor")
    const body = await c.req.json<CommunityPurchaseQuotePreflightRequest>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid purchase quote preflight payload")
    }
    const result = await preflightCommunityPurchaseQuote({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      body,
      communityRepository: getCommunityRepository(c.env),
      userRepository: getUserRepository(c.env),
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/purchase-quotes", async (c) => {
    const actor = c.get("actor")
    const body = await c.req.json<CommunityPurchaseQuoteRequest>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid purchase quote payload")
    }
    const result = await createCommunityPurchaseQuote({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      body,
      communityRepository: getCommunityRepository(c.env),
      userRepository: getUserRepository(c.env),
    })
    return c.json(result, 201)
  })

  communities.post("/:communityId/purchase-settlements", async (c) => {
    const actor = c.get("actor")
    const body = await c.req.json<CommunityPurchaseSettlementRequest>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid purchase settlement payload")
    }
    const result = await settleCommunityPurchase({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      body,
      communityRepository: getCommunityRepository(c.env),
    })
    return c.json(result, 201)
  })

  communities.post("/:communityId/purchase-settlements/fail", async (c) => {
    const actor = c.get("actor")
    const body = await c.req.json<CommunityPurchaseSettlementFailureRequest>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid purchase settlement failure payload")
    }
    const result = await failCommunityPurchase({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      body,
      communityRepository: getCommunityRepository(c.env),
    })
    return c.json(result, 200)
  })
}
