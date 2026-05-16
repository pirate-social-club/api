import type { DbExecutor } from "../db-helpers"
import { boundedPostJsonProjection } from "./community-post-projection"
import type { Post } from "../../types"

export async function updatePostLabelAssignment(input: {
  executor: DbExecutor
  postId: string
  labelId: string | null
  assignmentStatus: NonNullable<Post["label_assignment_status"]>
  assignedBy?: Post["label_assigned_by"]
  assignedAt?: string | null
  aiConfidence?: number | null
  assignmentError?: string | null
  assignmentModel?: string | null
  assignmentResultJson?: string | null
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET label_id = ?2,
          label_assignment_status = ?3,
          label_assigned_by = ?4,
          label_assigned_at = ?5,
          label_ai_confidence = ?6,
          label_assignment_error = ?7,
          label_assignment_model = ?8,
          label_assignment_result_json = ?9,
          updated_at = ?10
      WHERE post_id = ?1
    `,
    args: [
      input.postId,
      input.labelId,
      input.assignmentStatus,
      input.assignedBy ?? null,
      input.assignedAt ?? null,
      input.aiConfidence ?? null,
      input.assignmentError ?? null,
      input.assignmentModel ?? null,
      boundedPostJsonProjection(input.assignmentResultJson),
      input.now,
    ],
  })
}
