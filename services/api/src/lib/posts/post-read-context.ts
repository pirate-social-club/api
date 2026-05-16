import { openCommunityDb } from "../communities/community-db-factory"
import { isCommunityLive } from "../communities/community-status"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { notFoundError } from "../errors"
import type { Client } from "../sql-client"
import type { Env } from "../../env"

export type PostReadCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "getCommunityPostProjectionByPostId">

export type OpenPostReadCommunityDb = {
  client: Client
  communityId: string
  close: () => void
}

export async function openProjectedPostCommunityDb(input: {
  env: Env
  communityRepository: PostReadCommunityRepository
  postId: string
  requireLiveCommunity?: boolean
}): Promise<OpenPostReadCommunityDb> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  if (input.requireLiveCommunity) {
    const community = await input.communityRepository.getCommunityById(projection.community_id)
    if (!isCommunityLive(community)) {
      throw notFoundError("Post not found")
    }
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  return {
    client: db.client,
    communityId: projection.community_id,
    close: db.close,
  }
}

export async function openLiveCommunityDbForPostRead(input: {
  env: Env
  communityRepository: PostReadCommunityRepository
  communityId: string
}): Promise<OpenPostReadCommunityDb> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!isCommunityLive(community)) {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  return {
    client: db.client,
    communityId: input.communityId,
    close: db.close,
  }
}
