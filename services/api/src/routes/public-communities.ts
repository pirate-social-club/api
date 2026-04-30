import { Hono } from "hono"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import { getPublicCommunityPreview } from "../lib/communities/community-preview-service"
import {
  omittedSurfacesForPolicy,
  omittedSurfaceForPolicy,
  resolveEffectiveCommunityMachineAccessPolicy,
  type OmittedStructuredSurface,
} from "../lib/communities/community-machine-access-service"
import { listPublicCommunityPosts } from "../lib/posts/post-service"
import {
  absoluteUrl,
  configuredApiOrigin,
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
import type { CommunityPreview } from "../types"
import { publicCommunityId, publicPostId } from "../lib/public-ids"

const publicCommunities = new Hono<{ Bindings: Env }>()

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

function communityLinks(
  origin: string,
  communityId: string,
  routeSlug?: string | null,
): StructuredAccessLinks {
  const routeCommunityId = publicCommunityId(communityId)
  const canonicalSegment = routeSlug?.trim() || routeCommunityId
  return {
    self: {
      href: absoluteUrl(origin, publicCommunityPath(routeCommunityId)),
      type: "application/json",
    },
    canonical: {
      href: absoluteUrl(origin, `/c/${encodeURIComponent(canonicalSegment).replace(/^%40/u, "@")}`),
      type: "text/html",
    },
    markdown: {
      href: absoluteUrl(origin, `${publicCommunityPath(routeCommunityId)}?format=markdown`),
      type: "text/markdown",
    },
    posts: {
      href: absoluteUrl(origin, publicCommunityPostsPath(routeCommunityId)),
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

publicCommunities.get("/:communityId", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(communityRepository, c.req.param("communityId"))
  const policy = await resolveEffectiveCommunityMachineAccessPolicy({
    env: c.env,
    communityRepository,
    communityId,
  })
  const result = await getPublicCommunityPreview({
    env: c.env,
    communityId,
    locale: c.req.query("locale") ?? null,
    communityRepository,
  })
  const omittedSurfaces = omittedSurfacesForPolicy(policy, ["community_stats"])
  const links = communityLinks(configuredApiOrigin(c.env, c.req.url), communityId, result.route_slug)
  const serializedPreview = serializeCommunityPreview(result)
  const responseBody = {
    ...(policy.included_surfaces.community_stats ? serializedPreview : omitCommunityStats(serializedPreview)),
    omitted_surfaces: omittedSurfaces,
    links,
  }
  if (wantsMarkdown(c.req.raw, c.req.query("format"))) {
    return markdownResponse(communityMarkdown({
      preview: responseBody,
      links,
      omittedSurfaces,
    }), links)
  }
  c.header("Link", serializeLinkHeader(links))
  return c.json(responseBody, 200)
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

  const matches = rankedMatches
    .slice(0, limit)
    .map((community) => ({
      community: publicCommunityId(community.community_id),
      display_name: community.display_name,
      route_slug: community.route_slug,
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
    cursor: c.req.query("cursor"),
    flairId: c.req.query("flair_id"),
    limit: c.req.query("limit"),
    locale: c.req.query("locale"),
    sort: c.req.query("sort"),
  })
  const origin = configuredApiOrigin(c.env, c.req.url)
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
        href: absoluteUrl(origin, `/p/${encodeURIComponent(routePostId)}`),
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
    return markdownResponse(postListMarkdown({
      communityId,
      items,
      links,
      omittedSurfaces,
    }), links)
  }
  c.header("Link", serializeLinkHeader(links))
  return c.json(responseBody, 200)
})

export default publicCommunities
