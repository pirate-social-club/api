import type { DbExecutor } from "../db-helpers"
import type { CommunityPostProjectionRepository } from "../communities/db-community-repository"
import { getPostProjectionMetrics } from "./community-post-metrics-store"

export async function syncPostProjectionMetrics(input: {
  executor: DbExecutor
  communityRepository: Pick<CommunityPostProjectionRepository, "updateCommunityPostProjectionMetrics">
  postId: string
  updatedAt: string
}): Promise<void> {
  const metrics = await getPostProjectionMetrics(input.executor, input.postId)
  await input.communityRepository.updateCommunityPostProjectionMetrics({
    postId: input.postId,
    upvoteCount: metrics.upvoteCount,
    downvoteCount: metrics.downvoteCount,
    commentCount: metrics.commentCount,
    likeCount: metrics.likeCount,
    updatedAt: input.updatedAt,
  })
}
