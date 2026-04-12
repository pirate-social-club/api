import { Hono } from "hono"
import { badRequestError, notFoundError, verificationRequired } from "../lib/errors"
import { getUserRepository } from "../lib/auth/repositories"
import {
  listCommunityGateRules,
  upsertCommunityGateRule,
} from "../lib/communities/community-gate-rule-service"
import {
  getCommunityMoneyPolicy,
  quoteCommunityPurchasePreflight,
  updateCommunityMoneyPolicy,
} from "../lib/communities/community-money-policy-service"
import {
  getCommunityPricingPolicy,
  updateCommunityPricingPolicy,
} from "../lib/communities/community-pricing-policy-service"
import { quoteCommunityPurchase } from "../lib/communities/community-purchase-quote-service"
import {
  confirmCommunityPurchaseSettlement,
  failCommunityPurchaseSettlement,
} from "../lib/communities/community-purchase-settlement-service"
import {
  createCommunityListingRecord,
  getBuyerCommunityPurchase,
  getCommunityListingRecord,
  listBuyerCommunityPurchases,
  listCommunityListingRecords,
  updateCommunityListingRecord,
} from "../lib/communities/community-commerce-service"
import {
  approveMembershipRequest,
  archiveCommunityReferenceLink,
  getCommunityContentAuthenticityDetectionPolicy,
  getCommunityContentAuthenticityPolicy,
  createCommunityReferenceLink,
  createCommunity,
  getCommunityDonationPolicy,
  getCommunityFlairPolicy,
  getCommunityMarketContextPolicy,
  getCommunity,
  getCommunityByNamespace,
  getCommunityProfile,
  getCommunityReferenceLink,
  getCommunitySourcePolicy,
  joinCommunity,
  listDiscoverableCommunities,
  listCommunities,
  listCommunityReferenceLinks,
  listMembershipRequests,
  rejectMembershipRequest,
  type CreateCommunityRequestBody,
  updateCommunityContentAuthenticityPolicy,
  updateCommunityContentAuthenticityDetectionPolicy,
  updateCommunityDonationPolicy,
  updateCommunityFlairPolicy,
  updateCommunityMarketContextPolicy,
  updateCommunityReferenceLink,
  updateCommunitySourcePolicy,
  updateCommunity,
  updateCommunityProfile,
} from "../lib/communities/community-service"
import { requireCommunityModerationAccess } from "../lib/communities/community-service-shared"
import { getControlPlaneCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { getControlPlaneVerificationRepository } from "../lib/verification/control-plane-verification-repository"
import { nowIso, readBearerToken, requireBearerToken } from "../lib/helpers"
import { getControlPlaneSongArtifactBundleRepository } from "../lib/posts/control-plane-song-artifact-repository"
import { getControlPlaneSongArtifactUploadRepository } from "../lib/posts/control-plane-song-artifact-upload-repository"
import {
  abandonHeldSongDraft,
  attachUpstreamRefsAndPublish,
  createPost,
  createSongArtifactBundle,
  createSongArtifactUpload,
  decodeSongArtifactUploadBody,
  downloadCommunityAsset,
  getCommunityAsset,
  getCommunityAssetAccess,
  getCommunityAssetCdrManifest,
  issueCommunityAssetAccessProof,
  getSongArtifactBundle,
  listCommunityPosts,
  uploadSongArtifactContent,
} from "../lib/posts/post-service"
import { openCommunityDb } from "../lib/communities/community-db-factory"
import { getCommunityMembershipState, canAccessCommunity } from "../lib/communities/community-membership-store"
import {
  createUserReportAndAttachToCase,
  getModerationCaseDetail,
  listModerationCases,
  resolveModerationCaseWithAction,
} from "../lib/moderation/community-moderation-store"
import { getPostById } from "../lib/posts/community-post-store"
import { verifyPirateAccessToken } from "../lib/auth/pirate-session-token"
import { handleRoute, requireRouteParam, type AppRouteContext } from "./route-helpers"
import type {
  CreateModerationActionRequest,
  CreatePostRequest,
  CreateSongArtifactBundleRequest,
  CreateSongArtifactUploadRequest,
  CreateUserReportRequest,
  ModerationCaseStatus,
} from "../types"
import type { Env } from "../types"

const communities = new Hono<{ Bindings: Env }>()
const handleCommunityRoute = handleRoute

function normalizeNamespaceLabel(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase()
}

function communityIdParam(c: AppRouteContext): string {
  return requireRouteParam(c.req.param("communityId"), "community_id")
}

function postIdParam(c: AppRouteContext): string {
  return requireRouteParam(c.req.param("postId"), "post_id")
}

function listingIdParam(c: AppRouteContext): string {
  return requireRouteParam(c.req.param("listingId"), "listing_id")
}

function purchaseIdParam(c: AppRouteContext): string {
  return requireRouteParam(c.req.param("purchaseId"), "purchase_id")
}

function membershipRequestIdParam(c: AppRouteContext): string {
  return requireRouteParam(c.req.param("membershipRequestId"), "membership_request_id")
}

function referenceLinkIdParam(c: AppRouteContext): string {
  return requireRouteParam(c.req.param("communityReferenceLinkId"), "community_reference_link_id")
}

function moderationCaseIdParam(c: AppRouteContext): string {
  return requireRouteParam(c.req.param("moderationCaseId"), "moderation_case_id")
}

function songArtifactUploadIdParam(c: AppRouteContext): string {
  return requireRouteParam(c.req.param("songArtifactUploadId"), "song_artifact_upload_id")
}

function songArtifactBundleIdParam(c: AppRouteContext): string {
  return requireRouteParam(c.req.param("songArtifactBundleId"), "song_artifact_bundle_id")
}

function assetIdParam(c: AppRouteContext): string {
  return requireRouteParam(c.req.param("assetId"), "asset_id")
}

async function requireVerifiedHumanForModeration(input: {
  env: Env
  bearerToken: string
  userRepository: ReturnType<typeof getUserRepository>
}): Promise<{ userId: string }> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const user = await input.userRepository.getUserById(session.userId)
  if (!user) {
    throw notFoundError("User not found")
  }
  if (user.verification_capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }
  return { userId: session.userId }
}

async function syncCommunityPostProjection(input: {
  repository: ReturnType<typeof getControlPlaneCommunityRepository>
  post: Awaited<ReturnType<typeof getPostById>>
}): Promise<void> {
  if (!input.post) {
    return
  }
  const updatedAt = nowIso()
  const projectedPayloadJson = JSON.stringify(input.post)
  let updateError: unknown = null
  try {
    const updated = await input.repository.updateCommunityPostProjection({
      sourcePostId: input.post.post_id,
      status: input.post.status,
      projectedPayloadJson,
      updatedAt,
    })
    if (updated) {
      return
    }
  } catch (error) {
    updateError = error
  }
  try {
    await input.repository.reconcileCommunityPostProjection({
      communityId: input.post.community_id,
      sourcePostId: input.post.post_id,
      authorUserId: input.post.author_user_id ?? null,
      identityMode: input.post.identity_mode,
      postType: input.post.post_type,
      status: input.post.status,
      sourceCreatedAt: input.post.created_at,
      projectedPayloadJson,
      updatedAt,
    })
  } catch (error) {
    throw updateError ?? error
  }
}

communities.get("/", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await listCommunities({
    env: c.env,
    bearerToken: token,
    repository: getControlPlaneCommunityRepository(c.env),
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/discover", handleCommunityRoute(async (c) => {
  const result = await listDiscoverableCommunities({
    repository: getControlPlaneCommunityRepository(c.env),
    userRepository: getUserRepository(c.env),
    limit: c.req.query("limit"),
  })
  return c.json(result, 200)
}))

communities.post("/", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<CreateCommunityRequestBody>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community create payload")
  }

  const result = await createCommunity({
    env: c.env,
    bearerToken: token,
    body,
    userRepository: getUserRepository(c.env),
    verificationRepository: getControlPlaneVerificationRepository(c.env),
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 202)
}))

communities.get("/by-namespace/:namespaceLabel", handleCommunityRoute(async (c) => {
  const repository = getControlPlaneCommunityRepository(c.env)
  const rawNamespaceLabel = requireRouteParam(c.req.param("namespaceLabel"), "namespace_label")
  const normalizedLabel = normalizeNamespaceLabel(rawNamespaceLabel)
  if (!normalizedLabel) {
    throw badRequestError("Namespace label is required")
  }
  const result = await getCommunityByNamespace({
    namespaceLabel: normalizedLabel,
    namespaceLabelPrefixed: /^\s*@+/u.test(rawNamespaceLabel),
    repository,
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId", handleCommunityRoute(async (c) => {
  const repository = getControlPlaneCommunityRepository(c.env)
  const result = await getCommunity({
    communityId: communityIdParam(c),
    repository,
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.patch("/:communityId", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community update payload")
  }

  const result = await updateCommunity({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/community-profile", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunityProfile({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.patch("/:communityId/community-profile", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community profile payload")
  }

  const result = await updateCommunityProfile({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/reference-links", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await listCommunityReferenceLinks({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.post("/:communityId/reference-links", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community reference link payload")
  }
  const result = await createCommunityReferenceLink({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 201)
}))

communities.get("/:communityId/reference-links/:communityReferenceLinkId", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunityReferenceLink({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    communityReferenceLinkId: referenceLinkIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.patch("/:communityId/reference-links/:communityReferenceLinkId", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community reference link update payload")
  }
  const result = await updateCommunityReferenceLink({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    communityReferenceLinkId: referenceLinkIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.post("/:communityId/reference-links/:communityReferenceLinkId/archive", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await archiveCommunityReferenceLink({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    communityReferenceLinkId: referenceLinkIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/money-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const repository = getControlPlaneCommunityRepository(c.env)
  const result = await getCommunityMoneyPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository,
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/donation-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunityDonationPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/flairs", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunityFlairPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.patch("/:communityId/flairs", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community flair policy payload")
  }

  const result = await updateCommunityFlairPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.patch("/:communityId/donation-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community donation policy payload")
  }

  const result = await updateCommunityDonationPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/content-authenticity-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunityContentAuthenticityPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.patch("/:communityId/content-authenticity-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community content authenticity policy payload")
  }

  const result = await updateCommunityContentAuthenticityPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/content-authenticity-detection-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunityContentAuthenticityDetectionPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.patch("/:communityId/content-authenticity-detection-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community content authenticity detection policy payload")
  }

  const result = await updateCommunityContentAuthenticityDetectionPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/market-context-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunityMarketContextPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.patch("/:communityId/market-context-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community market-context policy payload")
  }

  const result = await updateCommunityMarketContextPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/source-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunitySourcePolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/gate-rules", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await listCommunityGateRules({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json({ gate_rules: result }, 200)
}))

communities.post("/:communityId/gate-rules", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community gate rule payload")
  }

  const result = await upsertCommunityGateRule({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body: body as {
      gate_rule_id?: string
      scope?: "membership" | "viewer" | "posting"
      gate_family?: "identity_proof" | "token_holding"
      gate_type?: string
      proof_requirements?: unknown[] | null
      chain_namespace?: string | null
      gate_config?: Record<string, unknown> | null
      status?: "active" | "disabled"
    },
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 201)
}))

communities.patch("/:communityId/source-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community source policy payload")
  }

  const result = await updateCommunitySourcePolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.patch("/:communityId/money-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community money policy payload")
  }

  const repository = getControlPlaneCommunityRepository(c.env)
  const result = await updateCommunityMoneyPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository,
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/pricing-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const repository = getControlPlaneCommunityRepository(c.env)
  const result = await getCommunityPricingPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository,
  })
  return c.json(result, 200)
}))

communities.patch("/:communityId/pricing-policy", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community pricing policy payload")
  }

  const repository = getControlPlaneCommunityRepository(c.env)
  const result = await updateCommunityPricingPolicy({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository,
  })
  return c.json(result, 200)
}))

communities.post("/:communityId/purchase-quote-preflight", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community purchase quote preflight payload")
  }

  const repository = getControlPlaneCommunityRepository(c.env)
  const result = await quoteCommunityPurchasePreflight({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository,
  })
  return c.json(result, 200)
}))

communities.post("/:communityId/purchase-quotes", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community purchase quote payload")
  }

  const repository = getControlPlaneCommunityRepository(c.env)
  const result = await quoteCommunityPurchase({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository,
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/listings", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await listCommunityListingRecords({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.post("/:communityId/listings", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community listing payload")
  }
  const result = await createCommunityListingRecord({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 201)
}))

communities.get("/:communityId/listings/:listingId", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunityListingRecord({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    listingId: listingIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.patch("/:communityId/listings/:listingId", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community listing update payload")
  }
  const result = await updateCommunityListingRecord({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    listingId: listingIdParam(c),
    body,
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/purchases", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await listBuyerCommunityPurchases({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/purchases/:purchaseId", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getBuyerCommunityPurchase({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    purchaseId: purchaseIdParam(c),
    repository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.post("/:communityId/purchase-settlements", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community purchase settlement payload")
  }

  const repository = getControlPlaneCommunityRepository(c.env)
  const result = await confirmCommunityPurchaseSettlement({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository,
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.post("/:communityId/purchase-settlements/fail", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community purchase settlement failure payload")
  }

  const repository = getControlPlaneCommunityRepository(c.env)
  const result = await failCommunityPurchaseSettlement({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    repository,
  })
  return c.json(result, 200)
}))

communities.post("/:communityId/join", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await joinCommunity({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    userRepository: getUserRepository(c.env),
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/membership-requests", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await listMembershipRequests({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.post("/:communityId/membership-requests/:membershipRequestId/approve", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<{ review_reason?: unknown }>().catch(() => null)
  if (body && typeof body === "object" && body.review_reason !== undefined && body.review_reason !== null && typeof body.review_reason !== "string") {
    throw badRequestError("Invalid membership approval payload")
  }

  const result = await approveMembershipRequest({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    membershipRequestId: membershipRequestIdParam(c),
    reviewReason: typeof body?.review_reason === "string" ? body.review_reason.trim() || null : null,
    communityRepository: getControlPlaneCommunityRepository(c.env),
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.post("/:communityId/membership-requests/:membershipRequestId/reject", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<{ review_reason?: unknown }>().catch(() => null)
  if (body && typeof body === "object" && body.review_reason !== undefined && body.review_reason !== null && typeof body.review_reason !== "string") {
    throw badRequestError("Invalid membership rejection payload")
  }

  const result = await rejectMembershipRequest({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    membershipRequestId: membershipRequestIdParam(c),
    reviewReason: typeof body?.review_reason === "string" ? body.review_reason.trim() || null : null,
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.post("/:communityId/posts", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<CreatePostRequest>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid post create payload")
  }

  const userRepository = getUserRepository(c.env)
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const result = await createPost({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    userRepository,
    communityRepository,
    songArtifactRepository: getControlPlaneSongArtifactBundleRepository(c.env),
  })
  return c.json(result, result.status === "published" ? 201 : 202)
}))

communities.post("/:communityId/posts/:postId/reports", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<CreateUserReportRequest>().catch(() => null)
  if (!body || typeof body.reason_code !== "string") {
    throw badRequestError("Invalid user report payload")
  }

  const userRepository = getUserRepository(c.env)
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const community = await communityRepository.getCommunityById(communityIdParam(c))
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }
  const session = await requireVerifiedHumanForModeration({
    env: c.env,
    bearerToken: token,
    userRepository,
  })

  const db = await openCommunityDb(communityRepository, communityIdParam(c))
  try {
    const membership = await getCommunityMembershipState(db.client, communityIdParam(c), session.userId)
    if (!canAccessCommunity(membership)) {
      throw notFoundError("Community not found")
    }
    const post = await getPostById(db.client, postIdParam(c))
    if (!post || post.community_id !== communityIdParam(c)) {
      throw notFoundError("Post not found")
    }
    const tx = await db.client.transaction("write")
    try {
      const report = await createUserReportAndAttachToCase({
        client: tx,
        communityId: communityIdParam(c),
        postId: postIdParam(c),
        reporterUserId: session.userId,
        reasonCode: body.reason_code,
        note: typeof body.note === "string" ? body.note.trim() || null : null,
        createdAt: nowIso(),
      })
      await tx.commit()
      return c.json(report, 201)
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}))

communities.get("/:communityId/moderation-cases", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const community = await communityRepository.getCommunityById(communityIdParam(c))
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const db = await openCommunityDb(communityRepository, communityIdParam(c))
  try {
    const membership = await getCommunityMembershipState(db.client, communityIdParam(c), session.userId)
    if (!canAccessCommunity(membership)) {
      throw notFoundError("Community not found")
    }
    await requireCommunityModerationAccess({
      dbClient: db.client,
      communityId: communityIdParam(c),
      userId: session.userId,
    })
    const rawStatus = c.req.query("status")
    const status: ModerationCaseStatus | null = rawStatus === "resolved" ? "resolved" : "open"
    return c.json({
      items: await listModerationCases({
        client: db.client,
        communityId: communityIdParam(c),
        status,
      }),
    }, 200)
  } finally {
    db.close()
  }
}))

communities.get("/:communityId/moderation-cases/:moderationCaseId", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const community = await communityRepository.getCommunityById(communityIdParam(c))
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const db = await openCommunityDb(communityRepository, communityIdParam(c))
  try {
    const membership = await getCommunityMembershipState(db.client, communityIdParam(c), session.userId)
    if (!canAccessCommunity(membership)) {
      throw notFoundError("Community not found")
    }
    await requireCommunityModerationAccess({
      dbClient: db.client,
      communityId: communityIdParam(c),
      userId: session.userId,
    })
    const detail = await getModerationCaseDetail({
      client: db.client,
      communityId: communityIdParam(c),
      moderationCaseId: moderationCaseIdParam(c),
    })
    return c.json(detail, 200)
  } finally {
    db.close()
  }
}))

communities.post("/:communityId/moderation-cases/:moderationCaseId/actions", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<CreateModerationActionRequest>().catch(() => null)
  if (!body || typeof body.action_type !== "string") {
    throw badRequestError("Invalid moderation action payload")
  }
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const community = await communityRepository.getCommunityById(communityIdParam(c))
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const db = await openCommunityDb(communityRepository, communityIdParam(c))
  try {
    const membership = await getCommunityMembershipState(db.client, communityIdParam(c), session.userId)
    if (!canAccessCommunity(membership)) {
      throw notFoundError("Community not found")
    }
    await requireCommunityModerationAccess({
      dbClient: db.client,
      communityId: communityIdParam(c),
      userId: session.userId,
    })

    const tx = await db.client.transaction("write")
    try {
      const result = await resolveModerationCaseWithAction({
        client: tx,
        communityId: communityIdParam(c),
        moderationCaseId: moderationCaseIdParam(c),
        actorUserId: session.userId,
        actionType: body.action_type,
        note: typeof body.note === "string" ? body.note.trim() || null : null,
        createdAt: nowIso(),
      })
      await tx.commit()
      if (result.postUpdated) {
        await syncCommunityPostProjection({
          repository: communityRepository,
          post: result.detail.post,
        })
      }
      return c.json(result.detail, 200)
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}))

communities.patch("/:communityId/posts/:postId/upstream-refs", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid upstream refs payload")
  }

  const userRepository = getUserRepository(c.env)
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const result = await attachUpstreamRefsAndPublish({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    postId: postIdParam(c),
    body,
    userRepository,
    communityRepository,
    songArtifactRepository: getControlPlaneSongArtifactBundleRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.delete("/:communityId/posts/:postId/publish-hold", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const userRepository = getUserRepository(c.env)
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  await abandonHeldSongDraft({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    postId: postIdParam(c),
    userRepository,
    communityRepository,
    songArtifactRepository: getControlPlaneSongArtifactBundleRepository(c.env),
  })
  return c.body(null, 204)
}))

communities.post("/:communityId/song-artifacts", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<CreateSongArtifactBundleRequest>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid song artifact create payload")
  }

  const userRepository = getUserRepository(c.env)
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const result = await createSongArtifactBundle({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    userRepository,
    communityRepository,
    songArtifactRepository: getControlPlaneSongArtifactBundleRepository(c.env),
    songArtifactUploadRepository: getControlPlaneSongArtifactUploadRepository(c.env),
  })
  return c.json(result, 201)
}))

communities.post("/:communityId/song-artifact-uploads", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<CreateSongArtifactUploadRequest>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid song artifact upload payload")
  }

  const userRepository = getUserRepository(c.env)
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const result = await createSongArtifactUpload({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    body,
    userRepository,
    communityRepository,
    uploadRepository: getControlPlaneSongArtifactUploadRepository(c.env),
  })
  return c.json(result, 201)
}))

communities.put("/:communityId/song-artifact-uploads/:songArtifactUploadId/content", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const contentType = c.req.header("content-type") ?? null
  const rawBytes = new Uint8Array(await c.req.arrayBuffer())
  let jsonBody: { content_base64?: unknown } | null = null
  if (String(contentType || "").toLowerCase().includes("application/json")) {
    jsonBody = JSON.parse(new TextDecoder().decode(rawBytes)) as { content_base64?: unknown }
  }
  const bytes = decodeSongArtifactUploadBody({
    contentType,
    jsonBody,
    rawBytes,
  })

  const userRepository = getUserRepository(c.env)
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const result = await uploadSongArtifactContent({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    uploadId: songArtifactUploadIdParam(c),
    bytes,
    userRepository,
    communityRepository,
    uploadRepository: getControlPlaneSongArtifactUploadRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/song-artifacts/:songArtifactBundleId", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getSongArtifactBundle({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    bundleId: songArtifactBundleIdParam(c),
    songArtifactRepository: getControlPlaneSongArtifactBundleRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/posts", handleCommunityRoute(async (c) => {
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const result = await listCommunityPosts({
    env: c.env,
    bearerToken: readBearerToken(c.req.header("authorization")),
    communityId: communityIdParam(c),
    locale: c.req.query("locale") ?? null,
    limit: c.req.query("limit") ?? null,
    cursor: c.req.query("cursor") ?? null,
    flairId: c.req.query("flair_id") ?? null,
    communityRepository,
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/assets/:assetId", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunityAsset({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    assetId: assetIdParam(c),
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/assets/:assetId/access", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunityAssetAccess({
    env: c.env,
    bearerToken: token,
    communityId: communityIdParam(c),
    assetId: assetIdParam(c),
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/assets/:assetId/access-proof", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await issueCommunityAssetAccessProof({
    env: c.env,
    bearerToken: token,
    communityId: String(communityIdParam(c)),
    assetId: String(assetIdParam(c)),
    walletAttachmentId: c.req.query("wallet_attachment_id") ?? null,
    communityRepository: getControlPlaneCommunityRepository(c.env),
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/assets/:assetId/cdr-manifest", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getCommunityAssetCdrManifest({
    env: c.env,
    bearerToken: token,
    communityId: String(communityIdParam(c)),
    assetId: String(assetIdParam(c)),
    walletAttachmentId: c.req.query("wallet_attachment_id") ?? null,
    communityRepository: getControlPlaneCommunityRepository(c.env),
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 200)
}))

communities.get("/:communityId/assets/:assetId/download", handleCommunityRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await downloadCommunityAsset({
    env: c.env,
    bearerToken: token,
    communityId: String(communityIdParam(c)),
    assetId: String(assetIdParam(c)),
    communityRepository: getControlPlaneCommunityRepository(c.env),
    songArtifactRepository: getControlPlaneSongArtifactBundleRepository(c.env),
    userRepository: getUserRepository(c.env),
  })
  return new Response(result.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": result.mimeType,
      "content-disposition": `attachment; filename="${result.filename}"`,
      "cache-control": "private, no-store",
    },
  })
}))

export default communities
