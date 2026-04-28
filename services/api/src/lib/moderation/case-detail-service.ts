import type { DbExecutor } from "../db-helpers"
import { getPostById } from "../posts/community-post-store"
import { getCommentById } from "../comments/community-comment-store"
import {
  listModerationActionsForCase,
  listModerationSignalsForCase,
  listUserReportsForCase,
} from "./community-moderation-store"
import type {
  ModerationCase,
  ModerationCaseDetail,
} from "./moderation-types"

export async function buildModerationCaseDetail(input: {
  caseRow: ModerationCase
  dbClient: DbExecutor
}): Promise<ModerationCaseDetail> {
  const post = input.caseRow.post_id ? await getPostById(input.dbClient, input.caseRow.post_id) : null
  const comment = input.caseRow.comment_id ? await getCommentById(input.dbClient, input.caseRow.comment_id) : null
  return {
    case: input.caseRow,
    post,
    comment,
    signals: await listModerationSignalsForCase({
      executor: input.dbClient,
      moderationCaseId: input.caseRow.moderation_case_id,
    }),
    reports: await listUserReportsForCase({
      executor: input.dbClient,
      moderationCaseId: input.caseRow.moderation_case_id,
    }),
    actions: await listModerationActionsForCase({
      executor: input.dbClient,
      moderationCaseId: input.caseRow.moderation_case_id,
    }),
  }
}
