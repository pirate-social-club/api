import { Hono } from "hono"
import { badRequestError } from "../lib/errors"
import { getUserRepository } from "../lib/auth/repositories"
import {
  attachNamespaceToCommunity,
  createCommunity,
  getCommunity,
  getCommunityPreview,
  getJoinEligibility,
  joinCommunity,
  setPendingNamespaceVerificationSession,
  type CreateCommunityRequestBody,
  type UpdateCommunityGatesRequestBody,
  type UpdateCommunitySafetyRequestBody,
  type UpdateCommunityRulesRequestBody,
  updateCommunityGates,
  updateCommunitySafety,
  updateCommunityRules,
} from "../lib/communities/community-service"
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
import { getCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { getControlPlaneVerificationRepository } from "../lib/verification/control-plane-verification-repository"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { createPost, listCommunityPosts } from "../lib/posts/post-service"
import {
  createSongArtifactBundle,
  createSongArtifactUpload,
  fetchSongArtifactContent,
  getSongArtifactBundleForCreator,
  uploadSongArtifactContent,
} from "../lib/song-artifacts/song-artifact-service"
import type {
  CommunityPurchaseQuotePreflightRequest,
  CommunityPurchaseQuoteRequest,
  CommunityPurchaseSettlementFailureRequest,
  CommunityPurchaseSettlementRequest,
  CreateCommunityListingRequest,
  CreatePostRequest,
  CreateSongArtifactBundleRequest,
  CreateSongArtifactUploadRequest,
  UpdateCommunityListingRequest,
  UpdateCommunityMoneyPolicyRequest,
  UpdateCommunityPricingPolicyRequest,
} from "../types"

const communities = new Hono<AuthenticatedEnv>()

communities.use("*", async (c, next) => {
  if (
    c.req.method === "GET"
    && /^\/communities\/[^/]+\/song-artifact-uploads\/[^/]+\/content$/.test(new URL(c.req.url).pathname)
  ) {
    await next()
    return
  }
  return authenticate(c, next)
})

communities.post("/", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<CreateCommunityRequestBody>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community create payload")
  }

  const result = await createCommunity({
    env: c.env,
    userId: actor.userId,
    body,
    userRepository: getUserRepository(c.env),
    verificationRepository: getControlPlaneVerificationRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 202)
})

communities.get("/:communityId", async (c) => {
  const actor = c.get("actor")
  const repository = getCommunityRepository(c.env)
  const result = await getCommunity({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    repository,
  })
  return c.json(result, 200)
})

communities.get("/:communityId/preview", async (c) => {
  const actor = c.get("actor")
  const result = await getCommunityPreview({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

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

communities.get("/:communityId/join-eligibility", async (c) => {
  const actor = c.get("actor")
  const result = await getJoinEligibility({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

communities.post("/:communityId/namespace", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ namespace_verification_id?: string | null }>().catch(() => null)
  const namespaceVerificationId = body?.namespace_verification_id?.trim()
  if (!namespaceVerificationId) {
    throw badRequestError("namespace_verification_id is required")
  }

  const result = await attachNamespaceToCommunity({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    namespaceVerificationId,
    userRepository: getUserRepository(c.env),
    verificationRepository: getControlPlaneVerificationRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

communities.put("/:communityId/pending-namespace-session", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ namespace_verification_session_id?: string | null }>().catch(() => null)
  const sessionId = typeof body?.namespace_verification_session_id === "string"
    ? body.namespace_verification_session_id.trim() || null
    : null

  const result = await setPendingNamespaceVerificationSession({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    sessionId,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

communities.put("/:communityId/rules", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<UpdateCommunityRulesRequestBody>().catch(() => null)
  if (!body || !Array.isArray(body.rules)) {
    throw badRequestError("Invalid community rules payload")
  }

  const result = await updateCommunityRules({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    body,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

communities.put("/:communityId/gates", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<UpdateCommunityGatesRequestBody>().catch(() => null)

  const result = await updateCommunityGates({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    body,
    communityRepository: getCommunityRepository(c.env),
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 200)
})

communities.put("/:communityId/safety", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<UpdateCommunitySafetyRequestBody>().catch(() => null)

  const result = await updateCommunitySafety({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    body,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

communities.post("/:communityId/join", async (c) => {
  const actor = c.get("actor")
  const result = await joinCommunity({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

communities.post("/:communityId/posts", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<CreatePostRequest>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid post create payload")
  }

  const userRepository = getUserRepository(c.env)
  const communityRepository = getCommunityRepository(c.env)
  const result = await createPost({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    body,
    userRepository,
    communityRepository,
  })
  return c.json(result, result.status === "published" ? 201 : 202)
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

communities.post("/:communityId/song-artifact-uploads", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<CreateSongArtifactUploadRequest>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid song artifact upload payload")
  }

  const result = await createSongArtifactUpload({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    body,
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
    origin: new URL(c.req.url).origin,
  })
  return c.json(result, 201)
})

communities.put("/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
  const actor = c.get("actor")
  const contentType = String(c.req.header("content-type") || "").toLowerCase()
  let content: ArrayBuffer | null = null

  if (contentType.includes("application/json")) {
    const body = await c.req.json<{ content_base64?: string | null }>().catch(() => null)
    const contentBase64 = body?.content_base64?.trim()
    if (!contentBase64) {
      throw badRequestError("content_base64 is required")
    }
    try {
      const decoded = atob(contentBase64)
      const bytes = new Uint8Array(decoded.length)
      for (let index = 0; index < decoded.length; index += 1) {
        bytes[index] = decoded.charCodeAt(index)
      }
      content = bytes.buffer
    } catch {
      throw badRequestError("content_base64 must be valid base64")
    }
  } else {
    const raw = await c.req.arrayBuffer().catch(() => null)
    if (!raw || raw.byteLength === 0) {
      throw badRequestError("Song artifact content is required")
    }
    content = raw
  }

  const result = await uploadSongArtifactContent({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    songArtifactUploadId: c.req.param("songArtifactUploadId"),
    content,
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
    origin: new URL(c.req.url).origin,
  })
  return c.json(result, 200)
})

communities.get("/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
  return await fetchSongArtifactContent({
    env: c.env,
    communityId: c.req.param("communityId"),
    songArtifactUploadId: c.req.param("songArtifactUploadId"),
  })
})

communities.post("/:communityId/song-artifacts", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<CreateSongArtifactBundleRequest>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid song artifact bundle payload")
  }

  const result = await createSongArtifactBundle({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    body,
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 201)
})

communities.get("/:communityId/song-artifacts/:songArtifactBundleId", async (c) => {
  const actor = c.get("actor")
  const result = await getSongArtifactBundleForCreator({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    songArtifactBundleId: c.req.param("songArtifactBundleId"),
  })
  return c.json(result, 200)
})

communities.get("/:communityId/posts", async (c) => {
  const actor = c.get("actor")
  const communityRepository = getCommunityRepository(c.env)
  const result = await listCommunityPosts({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    locale: c.req.query("locale") ?? null,
    limit: c.req.query("limit") ?? null,
    cursor: c.req.query("cursor") ?? null,
    flairId: c.req.query("flair_id") ?? null,
    communityRepository,
  })
  return c.json(result, 200)
})

export default communities
