import { isCommunityLive } from "../communities/community-status"
import type { CommunityPostProjectionRepository, CommunityReadRepository } from "../communities/db-community-repository"
import type { CommunityPostProjectionRow } from "../auth/auth-db-rows"
import { getProfilePublicHandleLabel } from "../auth/auth-serializers"
import type { ProfileRepository } from "../auth/repositories"
import type { LocalizedPostResponse, Post } from "../../types"

type CrosspostHydrationRepository =
  & CommunityReadRepository
  & Pick<CommunityPostProjectionRepository, "getCommunityPostProjectionByPostId">

type SourcePostType = Exclude<Post["post_type"], "crosspost">

function isSourcePostType(value: unknown): value is SourcePostType {
  return value === "text"
    || value === "image"
    || value === "video"
    || value === "link"
    || value === "song"
}

function parseProjectedPayload(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function firstMediaRef(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const mediaRefs = Array.isArray(payload?.media_refs) ? payload.media_refs : null
  const first = mediaRefs?.[0]
  return first && typeof first === "object" && !Array.isArray(first)
    ? first as Record<string, unknown>
    : null
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function resolveThumbnailRef(
  postType: SourcePostType,
  projectedPayload: Record<string, unknown> | null,
): string | null {
  if (postType === "image") {
    return stringField(firstMediaRef(projectedPayload)?.storage_ref)
  }
  if (postType === "video") {
    return stringField(firstMediaRef(projectedPayload)?.poster_ref)
  }
  if (postType === "link") {
    return stringField(projectedPayload?.link_og_image_url)
  }
  if (postType === "song") {
    return stringField(projectedPayload?.song_cover_art_ref)
      ?? stringField(firstMediaRef(projectedPayload)?.poster_ref)
  }
  return null
}

function unavailableSource(source: NonNullable<Post["crosspost_source"]>): NonNullable<Post["crosspost_source"]> {
  return {
    status: "unavailable",
    post_id: source.post_id,
    community_id: source.community_id,
    captured_at: source.captured_at ?? null,
  }
}

function sourceStatusFromProjection(
  projection: CommunityPostProjectionRow | null,
): NonNullable<Post["crosspost_source"]>["status"] {
  if (!projection) {
    return "unavailable"
  }
  if (projection.status === "deleted") {
    return "deleted"
  }
  if (projection.status === "removed") {
    return "removed"
  }
  if (projection.status !== "published" || projection.visibility !== "public") {
    return "unavailable"
  }
  return "available"
}

export async function hydrateCrosspostSources(input: {
  posts: Post[]
  communityRepository: CrosspostHydrationRepository
  profileRepository?: ProfileRepository | null
}): Promise<void> {
  const crossposts = input.posts.filter((post) => post.post_type === "crosspost" && post.crosspost_source)
  if (crossposts.length === 0) {
    return
  }

  const projectionByPostId = new Map<string, CommunityPostProjectionRow | null>()
  const sourcePostIds = [...new Set(crossposts.map((post) => post.crosspost_source!.post_id))]
  await Promise.all(sourcePostIds.map(async (sourcePostId) => {
    const projection = await input.communityRepository.getCommunityPostProjectionByPostId(sourcePostId).catch(() => null)
    projectionByPostId.set(sourcePostId, projection)
  }))

  const communityIds = [...new Set(crossposts.map((post) => post.crosspost_source!.community_id))]
  const communityById = new Map<string, Awaited<ReturnType<CrosspostHydrationRepository["getCommunityById"]>> | null>()
  await Promise.all(communityIds.map(async (communityId) => {
    const community = await input.communityRepository.getCommunityById(communityId).catch(() => null)
    communityById.set(communityId, community)
  }))

  const authorUserIds = [...new Set([...projectionByPostId.values()]
    .map((projection) => projection?.author_user_id ?? null)
    .filter((userId): userId is string => Boolean(userId)))]
  const authorLabelByUserId = new Map<string, string | null>()
  if (input.profileRepository && authorUserIds.length > 0) {
    const profilesByUserId = input.profileRepository.listProfilesByUserIds
      ? await input.profileRepository.listProfilesByUserIds(authorUserIds).catch(() => new Map())
      : new Map(await Promise.all(authorUserIds.map(async (userId): Promise<[
          string,
          Awaited<ReturnType<ProfileRepository["getProfileByUserId"]>>,
        ]> => [
          userId,
          await input.profileRepository!.getProfileByUserId(userId).catch(() => null),
        ])))
    for (const userId of authorUserIds) {
      const profile = profilesByUserId.get(userId) ?? null
      authorLabelByUserId.set(userId, profile ? getProfilePublicHandleLabel(profile) : null)
    }
  }

  for (const post of crossposts) {
    const source = post.crosspost_source!
    const projection = projectionByPostId.get(source.post_id) ?? null
    const status = sourceStatusFromProjection(projection)
    const community = communityById.get(source.community_id) ?? null
    if (
      status !== "available"
      || !projection
      || projection.community_id !== source.community_id
      || !isCommunityLive(community)
      || !isSourcePostType(projection.post_type)
    ) {
      post.crosspost_source = {
        ...unavailableSource(source),
        status,
      }
      continue
    }

    const projectedPayload = parseProjectedPayload(projection.projected_payload_json)
    post.crosspost_source = {
      status: "available",
      post_id: source.post_id,
      community_id: source.community_id,
      captured_at: source.captured_at ?? null,
      post_type: projection.post_type,
      title: typeof projectedPayload?.title === "string" ? projectedPayload.title : null,
      community_label: community.display_name,
      community_route_slug: community.route_slug,
      author_user_id: projection.author_user_id,
      author_label: projection.author_user_id ? authorLabelByUserId.get(projection.author_user_id) ?? null : null,
      thumbnail_ref: resolveThumbnailRef(projection.post_type, projectedPayload),
    }
  }
}

export async function hydrateCrosspostSourcesForResponses(input: {
  responses: LocalizedPostResponse[]
  communityRepository: CrosspostHydrationRepository
  profileRepository?: ProfileRepository | null
}): Promise<void> {
  await hydrateCrosspostSources({
    posts: input.responses.map((response) => response.post),
    communityRepository: input.communityRepository,
    profileRepository: input.profileRepository,
  })
}
