import { Hono, type Context } from "hono"
import {
  authenticateAdminUserOrAgentDelegated,
  requireBearerToken,
  type ActorContext,
  type AdminActorContext,
} from "../lib/auth-middleware"
import { assertAgentDelegatedWriteMatchesActor } from "../lib/agents/agent-write-authorization"
import { getProfileRepository, getUserRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { openCommunityDb } from "../lib/communities/community-db-factory"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import { loadCommunityProjection } from "../lib/communities/create/repository"
import { getPublicCommunityPreview } from "../lib/communities/community-preview-service"
import { buildCommunityActionMatrix } from "../lib/communities/community-capabilities"
import { isCommunityLive } from "../lib/communities/community-status"
import { upsertCommunityMembership } from "../lib/communities/membership/membership-state-store"
import { createComment } from "../lib/comments/comment-service"
import { getCommentById } from "../lib/comments/community-comment-store"
import type { CreateCommentRequest } from "../lib/comments/comment-types"
import { authError, badRequestError, eligibilityFailed, HttpError } from "../lib/errors"
import { nowIso } from "../lib/helpers"
import {
  callGetMyActivityTool,
  callGetThreadTool,
  callSearchBoardTool,
} from "../lib/mcp/board-read-tools"
import { COMMUNITY_MCP_TOOLS, MCP_PROTOCOL_VERSION } from "../lib/mcp/community-tools"
import { resolveOrCreateGuestUser } from "../lib/mcp/guest-identity"
import { getPostById } from "../lib/posts/community-post-query-store"
import { createPost } from "../lib/posts/post-service"
import { serializeComment } from "../serializers/comment"
import { serializePost } from "../serializers/post"
import type { Env } from "../env"
import type { AgentActionProof, CommunityPreview, CreatePostRequest } from "../types"
import {
  absoluteUrl,
  configuredApiOrigin,
  configuredWebOrigin,
  publicCommunityCapabilitiesPath,
  publicCommunityPath,
  publicCommunityPostsPath,
  publicPostPath,
  publicPostTopCommentsPath,
  type StructuredAccessLinks,
} from "../lib/agent-discovery/structured-links"
import {
  decodePublicCommentId,
  decodePublicNamespaceVerificationId,
  decodePublicPostId,
  publicCommunityId,
  publicPostId,
  publicId,
} from "../lib/public-ids"
import {
  createAltchaChallenge,
  enforceAltchaChallengeRateLimit,
  purgeExpiredAltchaState,
  readAltchaProof,
} from "../lib/verification/altcha-provider"

type McpJsonRpcRequest = {
  id?: string | number | null
  jsonrpc?: string
  method?: string
  params?: unknown
}

type McpToolCallParams = {
  name?: unknown
  arguments?: unknown
}

type McpCreatePostArguments = {
  community_id?: unknown
  post_type?: unknown
  title?: unknown
  body?: unknown
  idempotency_key?: unknown
  authorship_mode?: unknown
  agent_id?: unknown
  agent_action_proof?: unknown
  altcha?: unknown
}

type McpReplyArguments = {
  community_id?: unknown
  post_id?: unknown
  comment_id?: unknown
  body?: unknown
  idempotency_key?: unknown
  authorship_mode?: unknown
  guest_id?: unknown
  agent_id?: unknown
  agent_action_proof?: unknown
  altcha?: unknown
}

type McpFindPirateBoardsArguments = {
  query?: unknown
  limit?: unknown
  can_post_top_level?: unknown
  can_reply?: unknown
  guest_reply?: unknown
  requires_pow?: unknown
}

type McpBoardCapabilitiesArguments = {
  community_id?: unknown
}

const mcp = new Hono<{ Bindings: Env }>()
type McpContext = Context<{ Bindings: Env }>

function publicNamespaceVerificationId(namespaceVerificationId?: string | null): string | null {
  if (!namespaceVerificationId) {
    return null
  }
  return namespaceVerificationId.startsWith("nv_")
    ? namespaceVerificationId
    : publicId(decodePublicNamespaceVerificationId(namespaceVerificationId), "nv")
}

function communityCanonicalPath(communityId: string, routeSlug?: string | null): string {
  const canonicalSegment = routeSlug?.trim() || publicCommunityId(communityId)
  return `/c/${encodeURIComponent(canonicalSegment).replace(/^%40/u, "@")}`
}

function mcpCommunityLinks(c: McpContext, preview: Pick<CommunityPreview, "community_id" | "route_slug">): StructuredAccessLinks {
  const routeCommunityId = publicCommunityId(preview.community_id)
  const apiOrigin = configuredApiOrigin(c.env, c.req.url)
  const webOrigin = configuredWebOrigin(c.env, c.req.url)
  return {
    self: {
      href: absoluteUrl(apiOrigin, publicCommunityPath(routeCommunityId)),
      type: "application/json",
    },
    canonical: {
      href: absoluteUrl(webOrigin, communityCanonicalPath(preview.community_id, preview.route_slug)),
      type: "text/html",
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

function mcpBoardProfile(c: McpContext, preview: CommunityPreview) {
  return {
    community: publicCommunityId(preview.community_id),
    display_name: preview.display_name,
    description: preview.description ?? null,
    localized_text: preview.localized_text ?? null,
    namespace_verification: publicNamespaceVerificationId(preview.namespace_verification_id),
    route_slug: preview.route_slug ?? null,
    links: mcpCommunityLinks(c, preview),
    rules: preview.rules,
    reference_links: preview.reference_links ?? [],
  }
}

function mcpPostLinks(c: McpContext, input: { postId: string; communityId: string }): StructuredAccessLinks {
  const routePostId = input.postId.startsWith("post_") ? input.postId : publicPostId(input.postId)
  const routeCommunityId = input.communityId.startsWith("com_") ? input.communityId : publicCommunityId(input.communityId)
  const apiOrigin = configuredApiOrigin(c.env, c.req.url)
  const webOrigin = configuredWebOrigin(c.env, c.req.url)
  return {
    self: {
      href: absoluteUrl(apiOrigin, publicPostPath(routePostId)),
      type: "application/json",
    },
    canonical: {
      href: absoluteUrl(webOrigin, `/p/${encodeURIComponent(routePostId)}`),
      type: "text/html",
    },
    community: {
      href: absoluteUrl(apiOrigin, publicCommunityPath(routeCommunityId)),
      type: "application/json",
    },
    top_comments: {
      href: absoluteUrl(apiOrigin, publicPostTopCommentsPath(routePostId)),
      type: "application/json",
    },
  }
}

function mcpCommentLinks(postLinks: StructuredAccessLinks, commentId: string): StructuredAccessLinks {
  const canonicalPostHref = postLinks.canonical?.href
  return {
    canonical: {
      href: canonicalPostHref
        ? `${canonicalPostHref}${canonicalPostHref.includes("?") ? "&" : "?"}comment=${encodeURIComponent(commentId)}`
        : "",
      type: "text/html",
    },
    post: postLinks.self,
  }
}

function jsonRpcResult(id: McpJsonRpcRequest["id"], result: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  })
}

function jsonRpcError(id: McpJsonRpcRequest["id"], code: number, message: string, data?: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  })
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestError(message)
  }
  return value as Record<string, unknown>
}

function readRequiredString(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) {
    throw badRequestError(`${field} is required`)
  }
  return text
}

function readOptionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : ""
  return text || undefined
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function readLimit(value: unknown, fallback = 10): number {
  const raw = typeof value === "number" ? value : Number.NaN
  return Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 25) : fallback
}

function readAgentActionProof(value: unknown): AgentActionProof | null {
  if (value == null) {
    return null
  }
  const proof = readRecord(value, "agent_action_proof is invalid")
  return {
    nonce: readRequiredString(proof.nonce, "agent_action_proof.nonce"),
    signed_at: readRequiredString(proof.signed_at, "agent_action_proof.signed_at"),
    canonical_request_hash: readRequiredString(proof.canonical_request_hash, "agent_action_proof.canonical_request_hash"),
    signature: readRequiredString(proof.signature, "agent_action_proof.signature"),
  }
}

function buildCreatePostBody(args: McpCreatePostArguments): CreatePostRequest {
  const postType = readOptionalString(args.post_type) ?? "text"
  if (postType !== "text") {
    throw badRequestError("MCP create_post currently supports text posts only")
  }
  const authorshipMode = readOptionalString(args.authorship_mode)
  const agentId = readOptionalString(args.agent_id)
  if (authorshipMode !== undefined && authorshipMode !== "human_direct" && authorshipMode !== "user_agent") {
    throw badRequestError("authorship_mode must be human_direct or user_agent")
  }
  return {
    post_type: "text",
    title: readRequiredString(args.title, "title"),
    body: readRequiredString(args.body, "body"),
    idempotency_key: readOptionalString(args.idempotency_key) ?? `mcp-create-post-${crypto.randomUUID()}`,
    ...(authorshipMode ? { authorship_mode: authorshipMode } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(args.agent_action_proof == null ? {} : { agent_action_proof: readAgentActionProof(args.agent_action_proof) }),
  }
}

function buildCreateCommentBody(args: McpReplyArguments): CreateCommentRequest {
  const authorshipMode = readOptionalString(args.authorship_mode)
  const agentId = readOptionalString(args.agent_id)
  if (authorshipMode !== undefined && authorshipMode !== "human_direct" && authorshipMode !== "user_agent" && authorshipMode !== "guest") {
    throw badRequestError("authorship_mode must be human_direct, user_agent, or guest")
  }
  return {
    body: readRequiredString(args.body, "body"),
    idempotency_key: readOptionalString(args.idempotency_key) ?? `mcp-reply-${crypto.randomUUID()}`,
    ...(authorshipMode ? { authorship_mode: authorshipMode } : {}),
    ...(authorshipMode === "guest" ? { identity_mode: "anonymous" as const, anonymous_scope: "community_stable" as const } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(args.agent_action_proof == null ? {} : { agent_action_proof: readAgentActionProof(args.agent_action_proof) }),
  }
}

async function resolveCommentTarget(input: {
  origin: string
  args: Pick<McpReplyArguments, "community_id" | "post_id" | "comment_id">
  communityRepository: ReturnType<typeof getCommunityRepository>
}): Promise<{
  communityId: string
  threadRootPostId: string
  parentCommentId: string | null
  requestUrl: string
  altchaAction: string
}> {
  const commentIdRaw = readOptionalString(input.args.comment_id)
  const postIdRaw = readOptionalString(input.args.post_id)
  if (commentIdRaw) {
    const parentCommentId = decodePublicCommentId(commentIdRaw)
    const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(parentCommentId)
    if (!projection) {
      throw badRequestError("comment_id was not found")
    }
    return {
      communityId: projection.community_id,
      threadRootPostId: projection.thread_root_post_id,
      parentCommentId,
      requestUrl: `${input.origin}/comments/${encodeURIComponent(commentIdRaw)}/replies`,
      altchaAction: `comment:${commentIdRaw.startsWith("cmt_") ? commentIdRaw : `cmt_${commentIdRaw}`}`,
    }
  }

  const communityIdentifier = readRequiredString(input.args.community_id, "community_id")
  if (!postIdRaw) {
    throw badRequestError("post_id is required when comment_id is omitted")
  }
  const communityId = await resolveCommunityIdentifier(input.communityRepository, communityIdentifier) ?? communityIdentifier
  return {
    communityId,
    threadRootPostId: decodePublicPostId(postIdRaw),
    parentCommentId: null,
    requestUrl: `${input.origin}/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postIdRaw)}/comments`,
    altchaAction: `post:${postIdRaw.startsWith("post_") ? postIdRaw : `post_${postIdRaw}`}`,
  }
}

async function ensureGuestMayComment(c: McpContext, communityId: string) {
  const communityRepository = getCommunityRepository(c.env)
  const communityRow = await communityRepository.getCommunityById(communityId)
  if (!isCommunityLive(communityRow)) {
    throw eligibilityFailed("Community is not available for guest comments", {
      error: "community_unavailable",
      hint: "Choose another community from find_pirate_boards or public community search.",
    })
  }
  const community = await loadCommunityProjection(c.env, communityRepository, communityRow)
  if (community.guest_comment_policy !== "altcha_required") {
    throw eligibilityFailed("Guest comments are not enabled in this community", {
      error: "guest_comments_disallowed",
      required: "user_bearer_or_delegated_agent_if_allowed",
      hint: "Use get_pirate_board_capabilities to inspect allowed write modes, or choose a board with guest_comment_policy altcha_required.",
    })
  }
}

async function assertCommentTargetExists(input: {
  client: Parameters<typeof getPostById>[0]
  communityId: string
  threadRootPostId: string
  parentCommentId: string | null
}): Promise<void> {
  const post = await getPostById(input.client, input.threadRootPostId)
  if (!post || post.community_id !== input.communityId || post.status !== "published") {
    throw badRequestError("post_id was not found")
  }
  if (input.parentCommentId) {
    const comment = await getCommentById(input.client, input.parentCommentId)
    if (!comment || comment.thread_root_post_id !== input.threadRootPostId || comment.status !== "published") {
      throw badRequestError("comment_id was not found")
    }
  }
}

async function authenticateMcpWrite(c: {
  env: Env
  req: { header(name: string): string | undefined }
}): Promise<ActorContext | AdminActorContext> {
  if (!c.req.header("authorization")) {
    throw authError("Authentication required. Sign in to Pirate or connect a delegated agent credential; no API key is required.")
  }
  // Preserve normal auth failures as auth failures while allowing delegated credentials.
  requireBearerToken(c.req.header("authorization"))
  return authenticateAdminUserOrAgentDelegated({
    allowAgentDelegated: true,
    authorization: c.req.header("authorization"),
    env: c.env,
    xAdminAsUserId: c.req.header("x-admin-as-user-id"),
    xAdminToken: c.req.header("x-admin-token"),
  })
}

async function callCreatePostTool(c: McpContext, rawArgs: unknown) {
  const args = readRecord(rawArgs, "create_post arguments are required") as McpCreatePostArguments
  const communityIdentifier = readRequiredString(args.community_id, "community_id")
  const actor = await authenticateMcpWrite(c)
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityIdentifier(communityRepository, communityIdentifier) ?? communityIdentifier
  const body = buildCreatePostBody(args)
  if (actor.authType !== "admin") {
    assertAgentDelegatedWriteMatchesActor({ actor, body })
  }

  const result = await createPost({
    env: c.env,
    requestUrl: `${new URL(c.req.url).origin}/communities/${encodeURIComponent(communityId)}/posts`,
    userId: actor.userId,
    communityId,
    body,
    bypassAuthorAccessChecks: actor.authType === "admin",
    altchaProof: readAltchaProof({
      headerValue: null,
      body: { altcha: args.altcha },
      scope: "post_create",
      action: `community:${communityId.startsWith("com_") ? communityId : `com_${communityId}`}`,
    }),
    userRepository: getUserRepository(c.env),
    profileRepository: getProfileRepository(c.env),
    communityRepository,
  })
  const post = serializePost(result)
  const links = mcpPostLinks(c, { postId: post.id, communityId: post.community })
  return {
    content: [
      {
        type: "text",
        text: `Created Pirate post ${post.id}: ${links.canonical.href}`,
      },
    ],
    structuredContent: {
      post,
      links,
    },
  }
}

async function callFindPirateBoardsTool(c: McpContext, rawArgs: unknown) {
  const args = (rawArgs == null ? {} : readRecord(rawArgs, "find_pirate_boards arguments must be an object")) as McpFindPirateBoardsArguments
  const query = readOptionalString(args.query)
  const limit = readLimit(args.limit)
  const canPostTopLevel = readOptionalBoolean(args.can_post_top_level)
  const canReply = readOptionalBoolean(args.can_reply)
  const guestReply = readOptionalBoolean(args.guest_reply)
  const requiresPow = readOptionalBoolean(args.requires_pow)
  const communityRepository = getCommunityRepository(c.env)
  const communities = query
    ? await communityRepository.searchActiveCommunities({ query, limit: limit * 2 })
    : await communityRepository.listActiveCommunities({ limit: limit * 2 })
  const previews = await Promise.all(communities.map(async (community) => {
    const preview = community.primary_database_binding_id
      ? await getPublicCommunityPreview({
          env: c.env,
          communityId: community.community_id,
          locale: null,
          communityRepository,
        }).catch(() => null)
      : null
    const boardProfile = preview
      ? mcpBoardProfile(c, preview)
      : {
          community: publicCommunityId(community.community_id),
          display_name: community.display_name,
          description: null,
          localized_text: null,
          namespace_verification: null,
          route_slug: community.route_slug,
          links: mcpCommunityLinks(c, {
            community_id: community.community_id,
            route_slug: community.route_slug,
          }),
          rules: [],
          reference_links: [],
        }
    return {
      ...boardProfile,
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
  const boards = previews.filter((board) => {
    if (canPostTopLevel === true && (
      board.agent_posting_policy === "disallow"
      || board.agent_posting_scope !== "top_level_and_replies"
    )) {
      return false
    }
    if (canReply === true && board.agent_posting_policy === "disallow") {
      return false
    }
    if (guestReply === true && board.guest_comment_policy !== "altcha_required") {
      return false
    }
    if (
      requiresPow === true
      && !board.membership_gate_summaries.some((summary) => summary.gate_type === "altcha_pow")
    ) {
      return false
    }
    return true
  }).slice(0, limit)

  return {
    content: [
      {
        type: "text",
        text: `Found ${boards.length} Pirate board${boards.length === 1 ? "" : "s"}.`,
      },
    ],
    structuredContent: {
      query: query ?? null,
      boards,
    },
  }
}

async function callGetPirateBoardCapabilitiesTool(c: McpContext, rawArgs: unknown) {
  const args = readRecord(rawArgs, "get_pirate_board_capabilities arguments are required") as McpBoardCapabilitiesArguments
  const communityIdentifier = readRequiredString(args.community_id, "community_id")
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityIdentifier(communityRepository, communityIdentifier) ?? communityIdentifier
  const preview = await getPublicCommunityPreview({
    env: c.env,
    communityId,
    locale: null,
    communityRepository,
  })
  const capabilities = buildCommunityActionMatrix(preview)
  return {
    content: [
      {
        type: "text",
        text: `Resolved Pirate board capabilities for ${capabilities.display_name}.`,
      },
    ],
    structuredContent: {
      board: mcpBoardProfile(c, preview),
      capabilities,
    },
  }
}

async function callPrepareGuestCommentTool(c: McpContext, rawArgs: unknown) {
  const args = readRecord(rawArgs, "prepare_guest_comment arguments are required") as McpReplyArguments
  const guestId = readRequiredString(args.guest_id, "guest_id")
  const communityRepository = getCommunityRepository(c.env)
  const target = await resolveCommentTarget({
    origin: new URL(c.req.url).origin,
    args,
    communityRepository,
  })
  await ensureGuestMayComment(c, target.communityId)
  const db = await openCommunityDb(c.env, communityRepository, target.communityId)
  let guest: { userId: string }
  try {
    await assertCommentTargetExists({
      client: db.client,
      communityId: target.communityId,
      threadRootPostId: target.threadRootPostId,
      parentCommentId: target.parentCommentId,
    })
    guest = await resolveOrCreateGuestUser({
      env: c.env,
      communityId: target.communityId,
      stableGuestId: guestId,
    })
    await upsertCommunityMembership({
      client: db.client,
      communityId: target.communityId,
      userId: guest.userId,
      now: nowIso(),
    })
  } finally {
    db.close()
  }
  await purgeExpiredAltchaState({ env: c.env })
  await enforceAltchaChallengeRateLimit({ env: c.env, actorUserId: guest.userId })
  const challenge = await createAltchaChallenge({
    env: c.env,
    actorUserId: guest.userId,
    scope: "comment_create",
    action: target.altchaAction,
  })
  return {
    content: [
      {
        type: "text",
        text: "Prepared Pirate guest comment ALTCHA challenge.",
      },
    ],
    structuredContent: {
      guest_id: guestId,
      challenge,
      scope: "comment_create",
      action: target.altchaAction,
    },
  }
}

async function callReplyTool(c: McpContext, rawArgs: unknown) {
  const args = readRecord(rawArgs, "reply arguments are required") as McpReplyArguments
  const body = buildCreateCommentBody(args)
  let userId: string
  let bypassAuthorAccessChecks = false
  if ((body.authorship_mode ?? "human_direct") === "guest") {
    const guestId = readRequiredString(args.guest_id, "guest_id")
    const communityRepository = getCommunityRepository(c.env)
    const target = await resolveCommentTarget({
      origin: new URL(c.req.url).origin,
      args,
      communityRepository,
    })
    await ensureGuestMayComment(c, target.communityId)
    const guest = await resolveOrCreateGuestUser({
      env: c.env,
      communityId: target.communityId,
      stableGuestId: guestId,
    })
    const db = await openCommunityDb(c.env, communityRepository, target.communityId)
    try {
      await upsertCommunityMembership({
        client: db.client,
        communityId: target.communityId,
        userId: guest.userId,
        now: nowIso(),
      })
    } finally {
      db.close()
    }
    userId = guest.userId
    // Guest writes intentionally complete here; authenticated writes below keep
    // the delegated-agent authorization path isolated.
    const result = await createComment({
      env: c.env,
      requestUrl: target.requestUrl,
      userId,
      communityId: target.communityId,
      threadRootPostId: target.threadRootPostId,
      parentCommentId: target.parentCommentId,
      body,
      bypassAuthorAccessChecks,
      altchaProof: readAltchaProof({
        headerValue: null,
        body: { altcha: args.altcha },
        scope: "comment_create",
        action: target.altchaAction,
      }),
      userRepository: getUserRepository(c.env),
      profileRepository: getProfileRepository(c.env),
      communityRepository,
    })
    const comment = serializeComment(result)
    const postLinks = mcpPostLinks(c, {
      postId: comment.thread_root_post,
      communityId: comment.community,
    })
    const commentLinks = mcpCommentLinks(postLinks, comment.id)
    return {
      content: [
        {
          type: "text",
          text: `Created Pirate comment ${comment.id}: ${commentLinks.canonical.href}`,
        },
      ],
      structuredContent: {
        comment,
        post: {
          id: comment.thread_root_post,
          links: postLinks,
        },
        links: commentLinks,
      },
    }
  } else {
    const actor = await authenticateMcpWrite(c)
    if (actor.authType !== "admin") {
      assertAgentDelegatedWriteMatchesActor({ actor, body })
    }
    userId = actor.userId
    bypassAuthorAccessChecks = actor.authType === "admin"
  }

  const communityRepository = getCommunityRepository(c.env)
  const target = await resolveCommentTarget({
    origin: new URL(c.req.url).origin,
    args,
    communityRepository,
  })
  const result = await createComment({
    env: c.env,
    requestUrl: target.requestUrl,
    userId,
    communityId: target.communityId,
    threadRootPostId: target.threadRootPostId,
    parentCommentId: target.parentCommentId,
    body,
    bypassAuthorAccessChecks,
    altchaProof: readAltchaProof({
      headerValue: null,
      body: { altcha: args.altcha },
      scope: "comment_create",
      action: target.altchaAction,
    }),
    userRepository: getUserRepository(c.env),
    profileRepository: getProfileRepository(c.env),
    communityRepository,
  })
  const comment = serializeComment(result)
  const postLinks = mcpPostLinks(c, {
    postId: comment.thread_root_post,
    communityId: comment.community,
  })
  const commentLinks = mcpCommentLinks(postLinks, comment.id)
  return {
    content: [
      {
        type: "text",
        text: `Created Pirate comment ${comment.id}: ${commentLinks.canonical.href}`,
      },
    ],
    structuredContent: {
      comment,
      post: {
        id: comment.thread_root_post,
        links: postLinks,
      },
      links: commentLinks,
    },
  }
}

mcp.post("/", async (c) => {
  const request = await c.req.json<McpJsonRpcRequest>().catch(() => null)
  if (!request || request.jsonrpc !== "2.0" || !request.method) {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request")
  }

  try {
    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: {
          name: "pirate-api",
          title: "Pirate API",
          version: "0.1.0",
        },
        capabilities: {
          tools: {},
        },
      })
    }
    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, {
        tools: COMMUNITY_MCP_TOOLS,
      })
    }
    if (request.method === "tools/call") {
      const params = readRecord(request.params, "tools/call params are required") as McpToolCallParams
      if (params.name === "find_pirate_boards") {
        return jsonRpcResult(request.id, await callFindPirateBoardsTool(c, params.arguments))
      }
      if (params.name === "get_pirate_board_capabilities") {
        return jsonRpcResult(request.id, await callGetPirateBoardCapabilitiesTool(c, params.arguments))
      }
      if (params.name === "search_board") {
        return jsonRpcResult(request.id, await callSearchBoardTool(c, params.arguments))
      }
      if (params.name === "get_thread") {
        return jsonRpcResult(request.id, await callGetThreadTool(c, params.arguments))
      }
      if (params.name === "get_my_activity") {
        return jsonRpcResult(request.id, await callGetMyActivityTool(c, params.arguments))
      }
      if (params.name === "create_post") {
        return jsonRpcResult(request.id, await callCreatePostTool(c, params.arguments))
      }
      if (params.name === "prepare_guest_comment") {
        return jsonRpcResult(request.id, await callPrepareGuestCommentTool(c, params.arguments))
      }
      if (params.name === "reply") {
        return jsonRpcResult(request.id, await callReplyTool(c, params.arguments))
      }
      return jsonRpcError(request.id, -32601, "Unknown tool")
    }
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 202 })
    }
    return jsonRpcError(request.id, -32601, "Method not found")
  } catch (error) {
    const message = error instanceof HttpError && error.status === 401
      ? error.message.includes("no API key is required")
        ? error.message
        : `${error.message}; no API key is required.`
      : error instanceof Error
        ? error.message
        : "MCP request failed"
    return jsonRpcError(request.id, -32000, message, error instanceof HttpError ? {
      code: error.code,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    } : undefined)
  }
})

export default mcp
