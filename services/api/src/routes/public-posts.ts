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
import { structuredSurfaceDisabled } from "../lib/errors"
import type { CommentListResponse, Env, LocalizedPostResponse } from "../types"

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

function markdownResponse(markdown: string, links: StructuredAccessLinks): Response {
  return new Response(markdown, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      Link: serializeLinkHeader(links),
    },
  })
}

function wantsMarkdown(request: Request, format: string | null | undefined): boolean {
  if (format === "markdown" || format === "md") {
    return true
  }
  const accept = request.headers.get("accept") ?? ""
  return accept.includes("text/markdown")
}

function omittedSurfacesMarkdown(omittedSurfaces: OmittedStructuredSurface[]): string[] {
  if (!omittedSurfaces.length) {
    return []
  }
  return [
    "## Omitted surfaces",
    "",
    ...omittedSurfaces.map((surface) => `- ${surface.surface}: ${surface.reason}`),
    "",
  ]
}

function postMarkdown(input: {
  response: LocalizedPostResponse
  links: StructuredAccessLinks
  omittedSurfaces: OmittedStructuredSurface[]
}): string {
  return [
    `# ${input.response.post.title ?? input.response.post.post_id}`,
    "",
    typeof input.response.post.body === "string" ? input.response.post.body : "",
    "",
    typeof input.response.post.caption === "string" ? input.response.post.caption : "",
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
  comments: CommentListResponse
  links: StructuredAccessLinks
}): string {
  return [
    `# Top comments for ${input.post.post.title ?? input.post.post.post_id}`,
    "",
    `JSON: ${input.links.self.href}`,
    "",
    ...input.comments.items.flatMap((item, index) => [
      `## ${index + 1}. ${item.comment.comment_id}`,
      "",
      item.translated_body ?? item.comment.body ?? "",
      "",
    ]),
  ].join("\n")
}

function omitThreadBody<T extends LocalizedPostResponse>(response: T): T {
  const {
    body: _body,
    caption: _caption,
    lyrics: _lyrics,
    media_refs: _mediaRefs,
    embeds: _embeds,
    link_url: _linkUrl,
    ...post
  } = response.post
  const {
    translated_body: _translatedBody,
    translated_caption: _translatedCaption,
    ...rest
  } = response

  return {
    ...rest,
    post,
  } as T
}

publicPosts.get("/:postId/top-comments", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const post = await getPublicPost({
    env: c.env,
    postId: c.req.param("postId"),
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
      community_id: post.post.community_id,
      post_id: post.post.post_id,
      surface: "top_comments",
      reason: omittedSurface?.reason ?? "community_opt_out",
    })
  }
  const result = await listPublicPostComments({
    env: c.env,
    threadRootPostId: c.req.param("postId"),
    locale: c.req.query("locale") ?? null,
    sort: "top",
    cursor: null,
    limit: String(topCommentsLimit()),
    communityRepository,
  })
  const origin = configuredApiOrigin(c.env, c.req.url)
  const links: StructuredAccessLinks = {
    self: {
      href: absoluteUrl(origin, publicPostTopCommentsPath(c.req.param("postId"))),
      type: "application/json",
    },
    post: {
      href: absoluteUrl(origin, publicPostPath(c.req.param("postId"))),
      type: "application/json",
    },
    canonical: {
      href: absoluteUrl(origin, `/p/${encodeURIComponent(c.req.param("postId"))}`),
      type: "text/html",
    },
    markdown: {
      href: absoluteUrl(origin, `${publicPostTopCommentsPath(c.req.param("postId"))}?format=markdown`),
      type: "text/markdown",
    },
    community: {
      href: absoluteUrl(origin, publicCommunityPath(post.post.community_id)),
      type: "application/json",
    },
  }
  const responseBody = {
    ...result,
    top_comments_limit: topCommentsLimit(),
    omitted_surfaces: [],
    links,
    community_id: post.post.community_id,
  }
  if (wantsMarkdown(c.req.raw, c.req.query("format"))) {
    return markdownResponse(topCommentsMarkdown({
      post,
      comments: result,
      links,
    }), links)
  }
  c.header("Link", serializeLinkHeader(links))
  return c.json(responseBody, 200)
})

publicPosts.get("/:postId", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const result = await getPublicPost({
    env: c.env,
    postId: c.req.param("postId"),
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
      community_id: result.post.community_id,
      post_id: result.post.post_id,
      surface: "thread_cards",
      reason: omittedSurface?.reason ?? "community_opt_out",
    })
  }
  const links = publicPostLinks({
    origin: configuredApiOrigin(c.env, c.req.url),
    postId: result.post.post_id,
    communityId: result.post.community_id,
    includeTopComments: policy.included_surfaces.top_comments,
  })
  const omittedSurfaces = omittedSurfacesForPolicy(policy, ["thread_bodies", "top_comments"])
  const responseBody = {
    ...(policy.included_surfaces.thread_bodies ? result : omitThreadBody(result)),
    omitted_surfaces: omittedSurfaces,
    links,
  }
  if (wantsMarkdown(c.req.raw, c.req.query("format"))) {
    return markdownResponse(postMarkdown({
      response: responseBody,
      links,
      omittedSurfaces,
    }), links)
  }
  c.header("Link", serializeLinkHeader(links))
  return c.json(responseBody, 200)
})

export default publicPosts
