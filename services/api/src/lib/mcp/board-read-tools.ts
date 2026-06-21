import type { Context } from "hono"
import {
  authenticateAdminUserOrAgentDelegated,
  requireBearerToken,
  type ActorContext,
  type AdminActorContext,
} from "../auth-middleware"
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
} from "../agent-discovery/structured-links"
import {
  getThreadWithComments,
  listUserCommentsInCommunity,
  listUserPostsInCommunity,
  searchPublishedPosts,
  type BoardReadComment,
  type BoardReadPost,
  type BoardReadPostSearchResult,
} from "../communities/board-read/board-read-service"
import { openCommunityReadClient } from "../communities/community-read-access"
import { resolveCommunityIdentifier } from "../communities/community-identifier"
import { getPublicCommunityPreview } from "../communities/community-preview-service"
import { getCommunityRepository } from "../communities/db-community-repository"
import { authError, badRequestError } from "../errors"
import {
  decodePublicNamespaceVerificationId,
  decodePublicPostId,
  publicCommentId,
  publicCommunityId,
  publicId,
  publicPostId,
} from "../public-ids"
import type { Env } from "../../env"
import type { CommunityPreview } from "../../types"

type McpReadContext = Context<{ Bindings: Env }>

type McpSearchBoardArguments = {
  community_id?: unknown
  query?: unknown
  limit?: unknown
}

type McpGetThreadArguments = {
  community_id?: unknown
  post_id?: unknown
  comment_limit?: unknown
}

type McpMyActivityArguments = {
  community_id?: unknown
  limit?: unknown
}

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

function mcpCommunityLinks(c: McpReadContext, preview: Pick<CommunityPreview, "community_id" | "route_slug">): StructuredAccessLinks {
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

function mcpBoardProfile(c: McpReadContext, preview: CommunityPreview) {
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

function mcpPostLinks(c: McpReadContext, input: { postId: string; communityId: string }): StructuredAccessLinks {
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

function mcpBoardReadPost(c: McpReadContext, post: BoardReadPost | BoardReadPostSearchResult) {
  return {
    id: publicPostId(post.postId),
    community: publicCommunityId(post.communityId),
    title: post.title,
    post_type: post.postType,
    identity_mode: post.identityMode,
    visibility: post.visibility,
    body_excerpt: post.bodyExcerpt,
    caption_excerpt: post.captionExcerpt,
    comment_count: post.commentCount,
    created_at: post.createdAt,
    updated_at: post.updatedAt,
    ...("score" in post ? {
      score: post.score,
      keyword_score: post.keywordScore,
      recency_score: post.recencyScore,
    } : {}),
    links: mcpPostLinks(c, { postId: post.postId, communityId: post.communityId }),
  }
}

function mcpBoardReadComment(c: McpReadContext, comment: BoardReadComment) {
  const id = publicCommentId(comment.commentId)
  const postLinks = mcpPostLinks(c, {
    postId: comment.threadRootPostId,
    communityId: comment.communityId,
  })
  return {
    id,
    community: publicCommunityId(comment.communityId),
    thread_root_post: publicPostId(comment.threadRootPostId),
    thread_title: comment.threadTitle,
    identity_mode: comment.identityMode,
    body_excerpt: comment.bodyExcerpt,
    depth: comment.depth,
    score: comment.score,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    links: mcpCommentLinks(postLinks, id),
  }
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

function readLimit(value: unknown, fallback = 10): number {
  const raw = typeof value === "number" ? value : Number.NaN
  return Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 25) : fallback
}

async function authenticateMcpRead(c: {
  env: Env
  req: { header(name: string): string | undefined }
}): Promise<ActorContext | AdminActorContext> {
  if (!c.req.header("authorization")) {
    throw authError("Authentication required for this MCP read tool. Sign in to Pirate or connect a delegated agent credential; no API key is required.")
  }
  requireBearerToken(c.req.header("authorization"))
  return authenticateAdminUserOrAgentDelegated({
    allowAgentDelegated: true,
    authorization: c.req.header("authorization"),
    env: c.env,
    xAdminAsUserId: c.req.header("x-admin-as-user-id"),
    xAdminToken: c.req.header("x-admin-token"),
  })
}

export async function callSearchBoardTool(c: McpReadContext, rawArgs: unknown) {
  const args = readRecord(rawArgs, "search_board arguments are required") as McpSearchBoardArguments
  const communityIdentifier = readRequiredString(args.community_id, "community_id")
  const query = readOptionalString(args.query)
  const limit = readLimit(args.limit)
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityIdentifier(communityRepository, communityIdentifier) ?? communityIdentifier
  const preview = await getPublicCommunityPreview({
    env: c.env,
    communityId,
    locale: null,
    communityRepository,
  })
  const db = await openCommunityReadClient(c.env, communityRepository, communityId)
  try {
    const posts = await searchPublishedPosts(db.client, communityId, {
      excerptChars: 320,
      limit,
      query,
      visibility: "public",
    })
    return {
      content: [
        {
          type: "text",
          text: `Found ${posts.length} public thread${posts.length === 1 ? "" : "s"} on ${preview.display_name}.`,
        },
      ],
      structuredContent: {
        board: mcpBoardProfile(c, preview),
        query: query ?? null,
        posts: posts.map((post) => mcpBoardReadPost(c, post)),
      },
    }
  } finally {
    db.close()
  }
}

export async function callGetThreadTool(c: McpReadContext, rawArgs: unknown) {
  const args = readRecord(rawArgs, "get_thread arguments are required") as McpGetThreadArguments
  const communityIdentifier = readRequiredString(args.community_id, "community_id")
  const postId = decodePublicPostId(readRequiredString(args.post_id, "post_id"))
  const commentLimit = readLimit(args.comment_limit)
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityIdentifier(communityRepository, communityIdentifier) ?? communityIdentifier
  const preview = await getPublicCommunityPreview({
    env: c.env,
    communityId,
    locale: null,
    communityRepository,
  })
  const db = await openCommunityReadClient(c.env, communityRepository, communityId)
  try {
    const thread = await getThreadWithComments(db.client, postId, {
      commentLimit,
      excerptChars: 1_000,
      visibility: "public",
    })
    if (!thread || thread.post.communityId !== communityId) {
      throw badRequestError("post_id was not found")
    }
    return {
      content: [
        {
          type: "text",
          text: `Read Pirate thread ${publicPostId(thread.post.postId)} with ${thread.comments.length} comment${thread.comments.length === 1 ? "" : "s"}.`,
        },
      ],
      structuredContent: {
        board: mcpBoardProfile(c, preview),
        thread: {
          post: mcpBoardReadPost(c, thread.post),
          comments: thread.comments.map((comment) => mcpBoardReadComment(c, comment)),
        },
      },
    }
  } finally {
    db.close()
  }
}

export async function callGetMyActivityTool(c: McpReadContext, rawArgs: unknown) {
  const args = readRecord(rawArgs, "get_my_activity arguments are required") as McpMyActivityArguments
  const actor = await authenticateMcpRead(c)
  const communityIdentifier = readRequiredString(args.community_id, "community_id")
  const limit = readLimit(args.limit)
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityIdentifier(communityRepository, communityIdentifier) ?? communityIdentifier
  const preview = await getPublicCommunityPreview({
    env: c.env,
    communityId,
    locale: null,
    communityRepository,
  })
  const db = await openCommunityReadClient(c.env, communityRepository, communityId)
  try {
    const [posts, comments] = await Promise.all([
      listUserPostsInCommunity(db.client, communityId, actor.userId, {
        excerptChars: 320,
        limit,
      }),
      listUserCommentsInCommunity(db.client, communityId, actor.userId, {
        excerptChars: 320,
        limit,
      }),
    ])
    return {
      content: [
        {
          type: "text",
          text: `Found ${posts.length} post${posts.length === 1 ? "" : "s"} and ${comments.length} comment${comments.length === 1 ? "" : "s"} for your activity on ${preview.display_name}.`,
        },
      ],
      structuredContent: {
        board: mcpBoardProfile(c, preview),
        posts: posts.map((post) => mcpBoardReadPost(c, post)),
        comments: comments.map((comment) => mcpBoardReadComment(c, comment)),
      },
    }
  } finally {
    db.close()
  }
}
