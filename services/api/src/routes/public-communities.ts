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
import { badRequestError, notFoundError, structuredSurfaceDisabled } from "../lib/errors"
import { omitThreadBody, type ThreadBodyOmittedPostResponse } from "../lib/posts/thread-body-omission"
import type { CommunityPreview, Env, LocalizedPostResponse } from "../types"

const publicCommunities = new Hono<{ Bindings: Env }>()

type CommunityRepository = ReturnType<typeof getCommunityRepository>

function rankPublicCommunitySearchMatch(
  candidate: { display_name: string; route_slug: string | null },
  query: string,
): number | null {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return 4
  }

  const routeSlug = candidate.route_slug?.trim().toLowerCase() ?? ""
  const displayName = candidate.display_name.trim().toLowerCase()
  if (routeSlug && routeSlug === normalizedQuery) {
    return 0
  }
  if (displayName === normalizedQuery) {
    return 1
  }
  if (routeSlug && routeSlug.startsWith(normalizedQuery)) {
    return 2
  }
  if (displayName.startsWith(normalizedQuery)) {
    return 3
  }
  if (routeSlug && routeSlug.includes(normalizedQuery)) {
    return 4
  }
  if (displayName.includes(normalizedQuery)) {
    return 5
  }
  return null
}

async function resolveCommunityId(
  repository: CommunityRepository,
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
  const canonicalSegment = routeSlug?.trim() || communityId
  return {
    self: {
      href: absoluteUrl(origin, publicCommunityPath(communityId)),
      type: "application/json",
    },
    canonical: {
      href: absoluteUrl(origin, `/c/${encodeURIComponent(canonicalSegment).replace(/^%40/u, "@")}`),
      type: "text/html",
    },
    markdown: {
      href: absoluteUrl(origin, `${publicCommunityPath(communityId)}?format=markdown`),
      type: "text/markdown",
    },
    posts: {
      href: absoluteUrl(origin, publicCommunityPostsPath(communityId)),
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
  const links: StructuredAccessLinks = {
    self: {
      href: absoluteUrl(input.origin, publicCommunityPostsPath(input.communityId)),
      type: "application/json",
    },
    community: {
      href: absoluteUrl(input.origin, publicCommunityPath(input.communityId)),
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
  items: Array<(LocalizedPostResponse | ThreadBodyOmittedPostResponse) & {
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
      `- [${item.post.title ?? item.post.post_id}](${item.links.self.href})`,
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
  const responseBody = {
    ...(policy.included_surfaces.community_stats ? result : omitCommunityStats(result)),
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

  const matches = (await repository.listActiveCommunities())
    .map((community) => ({
      community_id: community.community_id,
      display_name: community.display_name,
      route_slug: community.route_slug,
      match_rank: rankPublicCommunitySearchMatch(community, query),
    }))
    .filter((community) => query.length === 0 || community.match_rank != null)
    .sort((left, right) => {
      const rankCompare = (left.match_rank ?? 99) - (right.match_rank ?? 99)
      if (rankCompare !== 0) {
        return rankCompare
      }
      return left.display_name.localeCompare(right.display_name, "en", { sensitivity: "base" })
    })
    .slice(0, limit)
    .map(({ match_rank: _matchRank, ...community }) => community)

  return c.json({
    query: query || null,
    communities: matches,
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
      community_id: communityId,
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
    const postLinks: StructuredAccessLinks = {
      self: {
        href: absoluteUrl(origin, publicPostPath(item.post.post_id)),
        type: "application/json",
      },
      canonical: {
        href: absoluteUrl(origin, `/p/${encodeURIComponent(item.post.post_id)}`),
        type: "text/html",
      },
      markdown: {
        href: absoluteUrl(origin, `${publicPostPath(item.post.post_id)}?format=markdown`),
        type: "text/markdown",
      },
      community: {
        href: absoluteUrl(origin, publicCommunityPath(item.post.community_id)),
        type: "application/json",
      },
    }
    if (policy.included_surfaces.top_comments) {
      postLinks.top_comments = {
        href: absoluteUrl(origin, publicPostTopCommentsPath(item.post.post_id)),
        type: "application/json",
      }
    }
    const itemOmittedSurfaces: OmittedStructuredSurface[] = omittedSurfacesForPolicy(policy, [
      "thread_bodies",
      "top_comments",
    ])
    return {
      ...(policy.included_surfaces.thread_bodies ? item : omitThreadBody(item)),
      omitted_surfaces: itemOmittedSurfaces,
      links: postLinks,
    }
  })
  const responseBody = {
    ...result,
    items,
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
