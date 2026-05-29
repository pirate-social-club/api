import type { DbExecutor } from "../db-helpers"
import type { PostEventStatus } from "../../types"

export async function setPostEventStatus(input: {
  executor: DbExecutor
  communityId: string
  postId: string
  status: PostEventStatus
  updatedAt: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE post_events
      SET status = ?1,
          updated_at = ?2
      WHERE post_id = ?3
        AND community_id = ?4
    `,
    args: [input.status, input.updatedAt, input.postId, input.communityId],
  })
}
