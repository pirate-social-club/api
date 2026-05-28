import { Hono } from "hono"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { getProfileRepository, getUserRepository } from "../lib/auth/repositories"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import { getPublicCommunityPreview } from "../lib/communities/community-preview-service"
import {
  createPublicCommunityPurchaseQuote,
  fetchPublicCommunityAssetContent,
  resolvePublicCommunityAssetAccess,
  settlePublicCommunityPurchase,
  type PublicCommunityPurchaseSettlementRequest,
} from "../lib/communities/commerce/service"
import {
  verifyPublicAssetAccessWalletProof,
  verifyPublicPurchaseQuoteWalletProof,
  type PublicWalletProof,
} from "../lib/communities/commerce/public-wallet-proof"
import {
  getPublicLiveRoomAccess,
  publicViewerAttachLiveRoom,
  publicViewerRenewLiveRoom,
  type LiveRoomViewerRenewRequest,
} from "../lib/communities/live-rooms/service"
import {
  defaultCommunityMachineAccessPolicy,
  omittedSurfacesForPolicy,
  omittedSurfaceForPolicy,
  resolveEffectiveCommunityMachineAccessPolicy,
  type OmittedStructuredSurface,
} from "../lib/communities/community-machine-access-service"
import type { CommunityRow } from "../lib/auth/auth-db-rows"
import { buildCommunityActionMatrix } from "../lib/communities/community-capabilities"
import { listPublicCommunityPosts } from "../lib/posts/post-service"
import { fetchPublishedPublicSongArtifactContent } from "../lib/song-artifacts/song-artifact-upload-service"
import {
  decodePublicAssetId,
  decodePublicSongArtifactUploadId,
  publicCommunityId,
  publicPostId,
} from "../lib/public-ids"
import {
  absoluteUrl,
  configuredApiOrigin,
  configuredWebOrigin,
  publicCommunityCapabilitiesPath,
  publicCommunityPath,
  publicCommunityPostsPath,
  publicPostPath,
  publicPostTopCommentsPath,
  serializeLinkHeader,
  type StructuredAccessLinks,
} from "../lib/agent-discovery/structured-links"
import {
  markdownResponse,
  omittedSurfacesMarkdown,
  wantsMarkdown,
} from "../lib/agent-discovery/markdown-helpers"
import type { CommunityRouteRepository } from "./communities-route-helpers"
import { badRequestError, notFoundError, structuredSurfaceDisabled } from "../lib/errors"
import { omitThreadBody } from "../lib/posts/thread-body-omission"
import { serializeCommunityPreview } from "../serializers/community"
import { serializeLocalizedPostResponse } from "../serializers/post"
import type { Env } from "../env"
import type { CommunityPreview, CommunityPurchaseQuoteRequest } from "../types"
import { setPublicReadCacheHeaders } from "./cache-headers"

const publicCommunities = new Hono<{ Bindings: Env }>()
const PUBLIC_COMMUNITY_PREVIEW_TIMEOUT_MS = 3000

async function resolveCommunityId(
  repository: CommunityRouteRepository,
  communityIdentifier: string,
): Promise<string> {
  const communityId = await resolveCommunityIdentifier(repository, communityIdentifier)
  if (communityId) {
    return communityId
  }

  throw notFoundError("Community not found")
}

async function resolveCommunityRow(
  repository: CommunityRouteRepository,
  communityIdentifier: string,
): Promise<CommunityRow> {
  const communityId = await resolveCommunityId(repository, communityIdentifier)
  const community = await repository.getCommunityById(communityId)
  if (!community || community.status !== "active") {
    throw notFoundError("Community not found")
  }
  return community
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function fallbackCommunityPreview(community: CommunityRow): CommunityPreview {
  return {
    community_id: community.community_id,
    namespace_verification_id: community.namespace_verification_id,
    route_slug: community.route_slug,
    display_name: community.display_name,
    description: community.description,
    localized_text: null,
    avatar_ref: community.avatar_ref,
    banner_ref: community.banner_ref,
    membership_mode: "gated",
    allow_anonymous_identity: false,
    anonymous_identity_scope: null,
    guest_comment_policy: "disallow",
    agent_posting_policy: "disallow",
    agent_posting_scope: "replies_only",
    agent_daily_post_cap: null,
    agent_daily_reply_cap: null,
    accepted_agent_ownership_providers: [],
    allowed_disclosed_qualifiers: null,
    allow_qualifiers_on_anonymous_posts: null,
    human_verification_lane: "very",
    member_count: null,
    follower_count: community.follower_count,
    donation_policy_mode: "none",
    donation_partner_id: null,
    donation_partner: null,
    owner: null,
    moderators: [],
    reference_links: [],
    membership_gate_summaries: [],
    rules: [],
    viewer_membership_status: "not_member",
    viewer_community_role: null,
    viewer_following: false,
    created_at: community.created_at,
  }
}

function communityLinks(
  apiOrigin: string,
  webOrigin: string,
  communityId: string,
  routeSlug?: string | null,
): StructuredAccessLinks {
  const routeCommunityId = publicCommunityId(communityId)
  const canonicalSegment = routeSlug?.trim() || routeCommunityId
  return {
    self: {
      href: absoluteUrl(apiOrigin, publicCommunityPath(routeCommunityId)),
      type: "application/json",
    },
    canonical: {
      href: absoluteUrl(webOrigin, `/c/${encodeURIComponent(canonicalSegment).replace(/^%40/u, "@")}`),
      type: "text/html",
    },
    markdown: {
      href: absoluteUrl(apiOrigin, `${publicCommunityPath(routeCommunityId)}?format=markdown`),
      type: "text/markdown",
    },
    posts: {
      href: absoluteUrl(apiOrigin, publicCommunityPostsPath(routeCommunityId)),
      type: "application/json",
    },
    capabilities: {
      href: absoluteUrl(apiOrigin, publicCommunityCapabilitiesPath(routeCommunityId)),
      type: "application/json",
    },
  }
}

function communityPostListLinks(input: {
  origin: string
  communityId: string
  nextCursor: string | null
  requestUrl: string
}): StructuredAccessLinks {
  const routeCommunityId = publicCommunityId(input.communityId)
  const links: StructuredAccessLinks = {
    self: {
      href: absoluteUrl(input.origin, publicCommunityPostsPath(routeCommunityId)),
      type: "application/json",
    },
    community: {
      href: absoluteUrl(input.origin, publicCommunityPath(routeCommunityId)),
      type: "application/json",
    },
  }
  if (input.nextCursor) {
    const next = new URL(input.requestUrl)
    next.searchParams.set("cursor", input.nextCursor)
    links.next = {
      href: next.toString(),
      type: "application/json",
    }
  }
  return links
}

function communityMarkdown(input: {
  preview: Partial<CommunityPreview>
  links: StructuredAccessLinks
  omittedSurfaces: OmittedStructuredSurface[]
}): string {
  return [
    `# ${input.preview.display_name ?? input.preview.community_id ?? "Community"}`,
    "",
    input.preview.description ?? "",
    "",
    "## Links",
    "",
    `- JSON: ${input.links.self.href}`,
    `- Posts: ${input.links.posts?.href ?? ""}`,
    "",
    ...("member_count" in input.preview || "follower_count" in input.preview
      ? [
          "## Stats",
          "",
          ...("member_count" in input.preview ? [`- Members: ${input.preview.member_count}`] : []),
          ...("follower_count" in input.preview ? [`- Followers: ${input.preview.follower_count}`] : []),
          "",
        ]
      : []),
    ...("agent_posting_policy" in input.preview || "guest_comment_policy" in input.preview
      ? [
          "## Agent Access",
          "",
          ...("agent_posting_policy" in input.preview ? [`- Agent posting policy: ${input.preview.agent_posting_policy}`] : []),
          ...("agent_posting_scope" in input.preview ? [`- Agent posting scope: ${input.preview.agent_posting_scope}`] : []),
          ...("agent_daily_post_cap" in input.preview ? [`- Agent daily post cap: ${input.preview.agent_daily_post_cap ?? "none"}`] : []),
          ...("agent_daily_reply_cap" in input.preview ? [`- Agent daily reply cap: ${input.preview.agent_daily_reply_cap ?? "none"}`] : []),
          ...("guest_comment_policy" in input.preview ? [`- Guest comment policy: ${input.preview.guest_comment_policy}`] : []),
          "",
        ]
      : []),
    ...(input.preview.rules?.length
      ? [
          "## Rules",
          "",
          ...input.preview.rules.map((rule) => `- ${rule.title}${rule.body ? `: ${rule.body}` : ""}`),
          "",
        ]
      : []),
    ...omittedSurfacesMarkdown(input.omittedSurfaces),
  ].join("\n")
}

function postListMarkdown(input: {
  communityId: string
  items: Array<{
    post: { title?: string | null; post_id?: string; id?: string; body?: string | null }
    links: StructuredAccessLinks
    omitted_surfaces: OmittedStructuredSurface[]
  }>
  links: StructuredAccessLinks
  omittedSurfaces: OmittedStructuredSurface[]
}): string {
  return [
    `# Posts for ${input.communityId}`,
    "",
    `JSON: ${input.links.self.href}`,
    "",
    ...input.items.flatMap((item) => [
      `- [${item.post.title ?? item.post.post_id ?? item.post.id}](${item.links.self.href})`,
      ...("body" in item.post && typeof item.post.body === "string" && item.post.body.trim()
        ? [`  ${item.post.body.trim()}`]
        : []),
    ]),
    "",
    ...omittedSurfacesMarkdown(input.omittedSurfaces),
  ].join("\n")
}

function omitCommunityStats<T extends Record<string, unknown>>(preview: T): Omit<T, "member_count" | "follower_count"> {
  const { member_count: _memberCount, follower_count: _followerCount, ...rest } = preview
  return rest
}

function requirePublicPurchaseQuoteBody(value: unknown): CommunityPurchaseQuoteRequest & { wallet_proof: PublicWalletProof } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestError("Invalid public purchase quote payload")
  }
  const body = value as Record<string, unknown>
  const proof = body.wallet_proof
  if (typeof body.listing !== "string" || !body.listing.trim()) {
    throw badRequestError("listing is required")
  }
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw badRequestError("wallet_proof is required")
  }
  const walletProof = proof as Record<string, unknown>
  if (
    typeof walletProof.wallet_address !== "string"
    || typeof walletProof.nonce !== "string"
    || typeof walletProof.issued_at !== "number"
    || typeof walletProof.signature !== "string"
  ) {
    throw badRequestError("wallet_proof is invalid")
  }
  return {
    listing: body.listing,
    funding_asset: body.funding_asset as CommunityPurchaseQuoteRequest["funding_asset"],
    source_chain: body.source_chain as CommunityPurchaseQuoteRequest["source_chain"],
    route_provider: typeof body.route_provider === "string" ? body.route_provider : null,
    client_estimated_slippage_bps: typeof body.client_estimated_slippage_bps === "number"
      ? body.client_estimated_slippage_bps
      : 0,
    client_estimated_hop_count: typeof body.client_estimated_hop_count === "number"
      ? body.client_estimated_hop_count
      : 0,
    client_route_valid_for_seconds: typeof body.client_route_valid_for_seconds === "number"
      ? body.client_route_valid_for_seconds
      : null,
    wallet_proof: {
      wallet_address: walletProof.wallet_address,
      chain_ref: typeof walletProof.chain_ref === "string" ? walletProof.chain_ref : null,
      nonce: walletProof.nonce,
      issued_at: walletProof.issued_at,
      signature: walletProof.signature,
    },
  }
}

function requirePublicAssetAccessBody(value: unknown): { wallet_proof: PublicWalletProof } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestError("Invalid public asset access payload")
  }
  const body = value as Record<string, unknown>
  const proof = body.wallet_proof
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw badRequestError("wallet_proof is required")
  }
  const walletProof = proof as Record<string, unknown>
  if (
    typeof walletProof.wallet_address !== "string"
    || typeof walletProof.nonce !== "string"
    || typeof walletProof.issued_at !== "number"
    || typeof walletProof.signature !== "string"
  ) {
    throw badRequestError("wallet_proof is invalid")
  }
  return {
    wallet_proof: {
      wallet_address: walletProof.wallet_address,
      chain_ref: typeof walletProof.chain_ref === "string" ? walletProof.chain_ref : null,
      nonce: walletProof.nonce,
      issued_at: walletProof.issued_at,
      signature: walletProof.signature,
    },
  }
}

function requirePublicPurchaseSettlementBody(value: unknown): PublicCommunityPurchaseSettlementRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestError("Invalid public purchase settlement payload")
  }
  const body = value as Record<string, unknown>
  if (typeof body.quote !== "string" || !body.quote.trim()) {
    throw badRequestError("quote is required")
  }
  if (typeof body.funding_tx_ref !== "string" || !body.funding_tx_ref.trim()) {
    throw badRequestError("funding_tx_ref is required")
  }
  if (
    body.settlement_tx_ref != null
    && (typeof body.settlement_tx_ref !== "string" || !body.settlement_tx_ref.trim())
  ) {
    throw badRequestError("settlement_tx_ref is invalid")
  }
  return {
    quote: body.quote,
    funding_tx_ref: body.funding_tx_ref,
    settlement_tx_ref: typeof body.settlement_tx_ref === "string" ? body.settlement_tx_ref : null,
  }
}

function requirePublicLiveRoomViewerRenewBody(value: unknown): LiveRoomViewerRenewRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestError("Invalid live room viewer renew payload")
  }
  const body = value as Record<string, unknown>
  if (typeof body.uid !== "number") {
    throw badRequestError("uid is required")
  }
  return {
    uid: body.uid,
  }
}

publicCommunities.post("/:communityId/purchase-quotes", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  const body = requirePublicPurchaseQuoteBody(await c.req.json().catch(() => null))
  const buyer = verifyPublicPurchaseQuoteWalletProof({
    communityId,
    listing: body.listing,
    proof: body.wallet_proof,
  })
  const result = await createPublicCommunityPurchaseQuote({
    env: c.env,
    buyer,
    communityId,
    body,
    communityRepository,
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 201)
})

publicCommunities.post("/:communityId/assets/:assetId/access", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  const asset = decodePublicAssetId(c.req.param("assetId"))
  const body = requirePublicAssetAccessBody(await c.req.json().catch(() => null))
  const buyer = verifyPublicAssetAccessWalletProof({
    communityId,
    asset: c.req.param("assetId"),
    proof: body.wallet_proof,
  })
  const result = await resolvePublicCommunityAssetAccess({
    env: c.env,
    buyer,
    communityId,
    assetId: asset,
    communityRepository,
  })
  return c.json(result, 200)
})

publicCommunities.get("/:communityId/assets/:assetId/content", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  return await fetchPublicCommunityAssetContent({
    env: c.env,
    communityId,
    assetId: decodePublicAssetId(c.req.param("assetId")),
    communityRepository,
  })
})

publicCommunities.post("/:communityId/purchase-settlements", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  const body = requirePublicPurchaseSettlementBody(await c.req.json().catch(() => null))
  const result = await settlePublicCommunityPurchase({
    env: c.env,
    communityId,
    body,
    communityRepository,
  })
  return c.json(result.settlement, 201)
})

publicCommunities.get("/:communityId/live-rooms/:liveRoomId/access", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  const access = await getPublicLiveRoomAccess({
    env: c.env,
    communityId,
    liveRoomId: c.req.param("liveRoomId"),
    communityRepository,
  })
  return c.json(access, 200)
})

publicCommunities.post("/:communityId/live-rooms/:liveRoomId/viewer_attach", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  const attach = await publicViewerAttachLiveRoom({
    env: c.env,
    communityId,
    liveRoomId: c.req.param("liveRoomId"),
    communityRepository,
  })
  return c.json(attach, 200)
})

publicCommunities.post("/:communityId/live-rooms/:liveRoomId/viewer_renew", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  const body = requirePublicLiveRoomViewerRenewBody(await c.req.json().catch(() => null))
  const renew = await publicViewerRenewLiveRoom({
    env: c.env,
    communityId,
    liveRoomId: c.req.param("liveRoomId"),
    body,
    communityRepository,
  })
  return c.json(renew, 200)
})

publicCommunities.get("/:communityId", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const community = await resolveCommunityRow(communityRepository, c.req.param("communityId"))
  const communityId = community.community_id
  const wantsSeoPreview = c.req.query("preview") === "seo"
  if (wantsSeoPreview && !wantsMarkdown(c.req.raw, c.req.query("format"))) {
    const preview = fallbackCommunityPreview(community)
    const links = communityLinks(configuredApiOrigin(c.env, c.req.url), configuredWebOrigin(c.env, c.req.url), communityId, preview.route_slug)
    const responseBody = {
      ...serializeCommunityPreview(preview),
      omitted_surfaces: [],
      links,
    }
    setPublicReadCacheHeaders(c, { vary: ["Accept"] })
    c.header("Link", serializeLinkHeader(links))
    return c.json(responseBody, 200)
  }
  const [policy, result] = await Promise.all([
    withTimeout(resolveEffectiveCommunityMachineAccessPolicy({
      env: c.env,
      communityRepository,
      communityId,
    }), PUBLIC_COMMUNITY_PREVIEW_TIMEOUT_MS),
    withTimeout(getPublicCommunityPreview({
      env: c.env,
      communityId,
      locale: c.req.query("locale") ?? null,
      communityRepository,
    }), PUBLIC_COMMUNITY_PREVIEW_TIMEOUT_MS),
  ])
  const isDegradedPreview = policy === null || result === null
  const effectivePolicy = policy ?? defaultCommunityMachineAccessPolicy({
    communityId,
    updatedAt: community.updated_at,
  })
  const preview = result ?? fallbackCommunityPreview(community)
  const omittedSurfaces = omittedSurfacesForPolicy(effectivePolicy, ["community_stats"])
  const links = communityLinks(configuredApiOrigin(c.env, c.req.url), configuredWebOrigin(c.env, c.req.url), communityId, preview.route_slug)
  const serializedPreview = serializeCommunityPreview(preview)
  const responseBody = {
    ...(effectivePolicy.included_surfaces.community_stats ? serializedPreview : omitCommunityStats(serializedPreview)),
    omitted_surfaces: omittedSurfaces,
    links,
  }
  if (wantsMarkdown(c.req.raw, c.req.query("format"))) {
    if (isDegradedPreview) {
      c.header("Cache-Control", "no-store")
      c.header("CDN-Cache-Control", "no-store")
    } else {
      setPublicReadCacheHeaders(c, { vary: ["Accept"] })
    }
    return markdownResponse(communityMarkdown({
      preview: responseBody,
      links,
      omittedSurfaces,
    }), links)
  }
  if (isDegradedPreview) {
    c.header("Cache-Control", "no-store")
    c.header("CDN-Cache-Control", "no-store")
  } else {
    setPublicReadCacheHeaders(c, { vary: ["Accept"] })
  }
  c.header("Link", serializeLinkHeader(links))
  return c.json(responseBody, 200)
})

publicCommunities.get("/:communityId/capabilities", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  const preview = await getPublicCommunityPreview({
    env: c.env,
    communityId,
    locale: c.req.query("locale") ?? null,
    communityRepository,
  })
  setPublicReadCacheHeaders(c, { vary: ["Accept"] })
  return c.json(buildCommunityActionMatrix(preview), 200)
})

publicCommunities.get("/", async (c) => {
  const repository = getCommunityRepository(c.env)
  const query = String(c.req.query("query") ?? "").trim()
  if (query.length < 2) {
    throw badRequestError("query must be at least 2 characters")
  }
  const rawLimit = Number.parseInt(String(c.req.query("limit") ?? "10"), 10)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 25)
    : 10

  const rankedMatches = await repository.searchActiveCommunities({ query, limit: limit + 1 })

  const matches = await Promise.all(rankedMatches
    .slice(0, limit)
    .map(async (community) => {
      const preview = community.primary_database_binding_id
        ? await getPublicCommunityPreview({
            env: c.env,
            communityId: community.community_id,
            locale: null,
            communityRepository: repository,
          }).catch(() => null)
        : null
      return {
        community: publicCommunityId(community.community_id),
        display_name: community.display_name,
        route_slug: community.route_slug,
        membership_mode: preview?.membership_mode ?? "gated",
        guest_comment_policy: preview?.guest_comment_policy ?? "disallow",
        agent_posting_policy: preview?.agent_posting_policy ?? "disallow",
        agent_posting_scope: preview?.agent_posting_scope ?? "replies_only",
        agent_daily_post_cap: preview?.agent_daily_post_cap ?? null,
        agent_daily_reply_cap: preview?.agent_daily_reply_cap ?? null,
        accepted_agent_ownership_providers: preview?.accepted_agent_ownership_providers ?? [],
        membership_gate_summaries: preview?.membership_gate_summaries ?? [],
      }
    }))

  return c.json({
    query: query || null,
    communities: matches,
    has_more: rankedMatches.length > limit,
  }, 200)
})

publicCommunities.get("/:communityId/posts", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  const policy = await resolveEffectiveCommunityMachineAccessPolicy({
    env: c.env,
    communityRepository,
    communityId,
  })
  if (!policy.included_surfaces.thread_cards) {
    const omittedSurface = omittedSurfaceForPolicy(policy, "thread_cards")
    throw structuredSurfaceDisabled("Thread cards are not available for structured access", {
      community: publicCommunityId(communityId),
      surface: "thread_cards",
      reason: omittedSurface?.reason ?? "community_opt_out",
    })
  }
  const result = await listPublicCommunityPosts({
    env: c.env,
    communityId,
    communityRepository,
    profileRepository: getProfileRepository(c.env),
    cursor: c.req.query("cursor"),
    flairId: c.req.query("flair_id"),
    limit: c.req.query("limit"),
    locale: c.req.query("locale"),
    sort: c.req.query("sort"),
  })
  const origin = configuredApiOrigin(c.env, c.req.url)
  const webOrigin = configuredWebOrigin(c.env, c.req.url)
  const links = communityPostListLinks({
    origin,
    communityId,
    nextCursor: result.next_cursor,
    requestUrl: c.req.url,
  })
  const omittedSurfaces = omittedSurfacesForPolicy(policy, ["thread_bodies", "top_comments"])
  const items = result.items.map((item) => {
    const routePostId = publicPostId(item.post.post_id)
    const routeCommunityId = publicCommunityId(item.post.community_id)
    const postLinks: StructuredAccessLinks = {
      self: {
        href: absoluteUrl(origin, publicPostPath(routePostId)),
        type: "application/json",
      },
      canonical: {
        href: absoluteUrl(webOrigin, `/p/${encodeURIComponent(routePostId)}`),
        type: "text/html",
      },
      markdown: {
        href: absoluteUrl(origin, `${publicPostPath(routePostId)}?format=markdown`),
        type: "text/markdown",
      },
      community: {
        href: absoluteUrl(origin, publicCommunityPath(routeCommunityId)),
        type: "application/json",
      },
    }
    if (policy.included_surfaces.top_comments) {
      postLinks.top_comments = {
        href: absoluteUrl(origin, publicPostTopCommentsPath(routePostId)),
        type: "application/json",
      }
    }
    const itemOmittedSurfaces: OmittedStructuredSurface[] = omittedSurfacesForPolicy(policy, [
      "thread_bodies",
      "top_comments",
    ])
    return {
      ...(policy.included_surfaces.thread_bodies ? serializeLocalizedPostResponse(item) : serializeLocalizedPostResponse(omitThreadBody(item))),
      omitted_surfaces: itemOmittedSurfaces,
      links: postLinks,
    }
  })
  const responseBody = {
    ...result,
    items,
    next_cursor: null,
    omitted_surfaces: omittedSurfaces,
    links,
  }
  if (wantsMarkdown(c.req.raw, c.req.query("format"))) {
    setPublicReadCacheHeaders(c, { vary: ["Accept"] })
    return markdownResponse(postListMarkdown({
      communityId,
      items,
      links,
      omittedSurfaces,
    }), links)
  }
  setPublicReadCacheHeaders(c, { vary: ["Accept"] })
  c.header("Link", serializeLinkHeader(links))
  return c.json(responseBody, 200)
})

publicCommunities.get("/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  return await fetchPublishedPublicSongArtifactContent({
    env: c.env,
    communityId,
    songArtifactUploadId: decodePublicSongArtifactUploadId(c.req.param("songArtifactUploadId")),
    communityRepository,
    origin: new URL(c.req.url).origin,
    rangeHeader: c.req.header("range"),
  })
})

publicCommunities.on("HEAD", "/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  const response = await fetchPublishedPublicSongArtifactContent({
    env: c.env,
    communityId,
    songArtifactUploadId: decodePublicSongArtifactUploadId(c.req.param("songArtifactUploadId")),
    communityRepository,
    origin: new URL(c.req.url).origin,
    rangeHeader: c.req.header("range"),
  })
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  })
})

export default publicCommunities
