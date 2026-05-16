import { openCommunityDb } from "../communities/community-db-factory"
import { isCommunityLive } from "../communities/community-status"
import { resolveCommunityIdentifier } from "../communities/community-identifier"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { badRequestError, eligibilityFailed, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { decodePublicPostId } from "../public-ids"
import type { Env } from "../../env"
import type { Post } from "../../types"
import { getPostById } from "./community-post-query-store"

export type PostCreateCrosspostSourceRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "getCommunityPostProjectionByPostId">

export async function resolveCrosspostSource(input: {
  env: Env
  communityRepository: PostCreateCrosspostSourceRepository
  sourcePostRef: string
  sourceCommunityRef: string
}): Promise<NonNullable<Post["crosspost_source"]>> {
  const sourcePostId = decodePublicPostId(input.sourcePostRef)
  const claimedCommunityId = await resolveCommunityIdentifier(
    input.communityRepository,
    input.sourceCommunityRef,
  )
  if (!claimedCommunityId) {
    throw badRequestError("source_community was not found")
  }

  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(sourcePostId)
  if (!projection) {
    throw notFoundError("Source post not found")
  }
  if (projection.community_id !== claimedCommunityId) {
    throw badRequestError("source_community does not match source_post")
  }

  const communityRow = await input.communityRepository.getCommunityById(projection.community_id)
  if (!isCommunityLive(communityRow)) {
    throw notFoundError("Source post not found")
  }

  const sourceDb = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    const sourcePost = await getPostById(sourceDb.client, sourcePostId)
    if (!sourcePost || sourcePost.community_id !== projection.community_id) {
      throw notFoundError("Source post not found")
    }
    if (sourcePost.post_type === "crosspost") {
      throw badRequestError("Crossposting a crosspost is not supported")
    }
    if (sourcePost.parent_post_id) {
      throw badRequestError("Crossposting a reply is not supported")
    }
    if (sourcePost.status !== "published" || sourcePost.visibility !== "public") {
      throw eligibilityFailed("Source post is not available for crossposting")
    }
    return {
      status: "unavailable",
      post_id: sourcePost.post_id,
      community_id: sourcePost.community_id,
      captured_at: nowIso(),
    }
  } finally {
    sourceDb.close()
  }
}
