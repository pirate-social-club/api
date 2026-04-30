import { Hono } from "hono"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import {
  omittedSurfacesForPolicy,
  omittedSurfaceForPolicy,
  resolveEffectiveCommunityMachineAccessPolicy,
  topCommentsLimit,
  type OmittedStructuredSurface,
} from "../lib/communities/community-machine-access-service"
import { listPublicPostComments } from "../lib/comments/comment-service"
import { getPublicPost } from "../lib/posts/post-service"
import {
  absoluteUrl,
  configuredApiOrigin,
  publicCommunityPath,
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
import { structuredSurfaceDisabled } from "../lib/errors"
import { omitThreadBody, type ThreadBodyOmittedPostResponse } from "../lib/posts/thread-body-omission"
import { serializeCommentListResponse } from "../serializers/comment"
import { serializeLocalizedPostResponse } from "../serializers/post"
import type { Env } from "../env"
import type { LocalizedPostResponse } from "../types"
import { decodePublicPostId, publicCommunityId, publicPostId } from "../lib/public-ids"

const publicPosts = new Hono<{ Bindings: Env }>()

function publicPostLinks(input: {
  origin: string
  postId: string
  communityId: string
  includeTopComments?: boolean
}): StructuredAccessLinks {
  const links: StructuredAccessLinks = {
    self: {
      href: absoluteUrl(input.origin, publicPostPath(input.postId)),
      type: "application/json",
    },
    canonical: {
      href: absoluteUrl(input.origin, `/p/${encodeURIComponent(input.postId)}`),
      type: "text/html",
    },
    markdown: {
      href: absoluteUrl(input.origin, `${publicPostPath(input.postId)}?format=markdown`),
      type: "text/markdown",
    },
    community: {
      href: absoluteUrl(input.origin, publicCommunityPath(input.communityId)),
      type: "application/json",
    },
  }
  if (input.includeTopComments !== false) {
    links.top_comments = {
      href: absoluteUrl(input.origin, publicPostTopCommentsPath(input.postId)),
      type: "application/json",
    }
  }
  return links
}

function postMarkdown(input: {
  response: LocalizedPostResponse | ThreadBodyOmittedPostResponse
  links: StructuredAccessLinks
  omittedSurfaces: OmittedStructuredSurface[]
}): string {
  return [
    `# ${input.response.post.title ?? input.response.post.post_id}`,
    "",
    "body" in input.response.post && typeof input.response.post.body === "string" ? input.response.post.body : "",
    "",
    "caption" in input.response.post && typeof input.response.post.caption === "string" ? input.response.post.caption : "",
    "",
    "## Links",
    "",
    `- JSON: ${input.links.self.href}`,
    `- Community: ${input.links.community?.href ?? ""}`,
    ...(input.links.top_comments ? [`- Top comments: ${input.links.top_comments.href}`] : []),
    "",
    ...omittedSurfacesMarkdown(input.omittedSurfaces),
  ].join("\n")
}

function topCommentsMarkdown(input: {
  post: LocalizedPostResponse
  comments: ReturnType<typeof serializeCommentListResponse>
  links: StructuredAccessLinks
}): string {
  return [
    `# Top comments for ${input.post.post.title ?? input.post.post.post_id}`,
    "",
    `JSON: ${input.links.self.href}`,
    "",
    ...input.comments.items.flatMap((item, index) => [
      `## ${index + 1}. ${item.comment.id}`,
      "",
      item.translated_body ?? item.comment.body ?? "",
      "",
    ]),
  ].join("\n")
}

publicPosts.get("/:postId/top-comments", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const rawPostId = decodePublicPostId(c.req.param("postId"))
  const post = await getPublicPost({
    env: c.env,
    postId: rawPostId,
    locale: c.req.query("locale") ?? null,
    communityRepository,
  })
  const policy = await resolveEffectiveCommunityMachineAccessPolicy({
    env: c.env,
    communityRepository,
    communityId: post.post.community_id,
  })
  if (!policy.included_surfaces.top_comments) {
    const omittedSurface = omittedSurfaceForPolicy(policy, "top_comments")
    throw structuredSurfaceDisabled("Top comments are not available for structured access", {
      community: publicCommunityId(post.post.community_id),
      post: publicPostId(post.post.post_id),
      surface: "top_comments",
      reason: omittedSurface?.reason ?? "community_opt_out",
    })
  }
  const result = await listPublicPostComments({
    env: c.env,
    threadRootPostId: rawPostId,
    locale: c.req.query("locale") ?? null,
    sort: "top",
    cursor: null,
    limit: String(topCommentsLimit()),
    communityRepository,
  })
  const origin = configuredApiOrigin(c.env, c.req.url)
  const routePostId = publicPostId(rawPostId)
  const links: StructuredAccessLinks = {
    self: {
      href: absoluteUrl(origin, publicPostTopCommentsPath(routePostId)),
      type: "application/json",
    },
    post: {
      href: absoluteUrl(origin, publicPostPath(routePostId)),
      type: "application/json",
    },
    canonical: {
      href: absoluteUrl(origin, `/p/${encodeURIComponent(routePostId)}`),
      type: "text/html",
    },
    markdown: {
      href: absoluteUrl(origin, `${publicPostTopCommentsPath(routePostId)}?format=markdown`),
      type: "text/markdown",
    },
    community: {
      href: absoluteUrl(origin, publicCommunityPath(publicCommunityId(post.post.community_id))),
      type: "application/json",
    },
  }
  const serializedComments = serializeCommentListResponse(result)
  const responseBody = {
    ...serializedComments,
    next_cursor: null,
    top_comments_limit: topCommentsLimit(),
    omitted_surfaces: [],
    links,
    community: publicCommunityId(post.post.community_id),
  }
  if (wantsMarkdown(c.req.raw, c.req.query("format"))) {
    return markdownResponse(topCommentsMarkdown({
      post,
      comments: serializedComments,
      links,
    }), links)
  }
  c.header("Link", serializeLinkHeader(links))
  return c.json(responseBody, 200)
})

publicPosts.get("/:postId", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const rawPostId = decodePublicPostId(c.req.param("postId"))
  const result = await getPublicPost({
    env: c.env,
    postId: rawPostId,
    locale: c.req.query("locale") ?? null,
    communityRepository,
  })
  const policy = await resolveEffectiveCommunityMachineAccessPolicy({
    env: c.env,
    communityRepository,
    communityId: result.post.community_id,
  })
  if (!policy.included_surfaces.thread_cards) {
    const omittedSurface = omittedSurfaceForPolicy(policy, "thread_cards")
    throw structuredSurfaceDisabled("Thread cards are not available for structured access", {
      community: publicCommunityId(result.post.community_id),
      post: publicPostId(result.post.post_id),
      surface: "thread_cards",
      reason: omittedSurface?.reason ?? "community_opt_out",
    })
  }
  const links = publicPostLinks({
    origin: configuredApiOrigin(c.env, c.req.url),
    postId: publicPostId(result.post.post_id),
    communityId: publicCommunityId(result.post.community_id),
    includeTopComments: policy.included_surfaces.top_comments,
  })
  const omittedSurfaces = omittedSurfacesForPolicy(policy, ["thread_bodies", "top_comments"])
  const markdownBody = policy.included_surfaces.thread_bodies ? result : omitThreadBody(result)
  const responseBody = {
    ...(policy.included_surfaces.thread_bodies
      ? serializeLocalizedPostResponse(result)
      : serializeLocalizedPostResponse(omitThreadBody(result))),
    omitted_surfaces: omittedSurfaces,
    links,
  }
  if (wantsMarkdown(c.req.raw, c.req.query("format"))) {
    return markdownResponse(postMarkdown({
      response: markdownBody,
      links,
      omittedSurfaces,
    }), links)
  }
  c.header("Link", serializeLinkHeader(links))
  return c.json(responseBody, 200)
})

export default publicPosts
