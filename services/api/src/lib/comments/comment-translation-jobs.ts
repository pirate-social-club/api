import type { Client } from "../sql-client"
import type { DbExecutor } from "../db-helpers"
import { enqueueCommunityJob } from "../communities/jobs/store"
import { buildLocalizedCommentListItem } from "../localization/comment-localization-service"
import { CONTENT_TRANSLATION_PREWARM_LOCALES, sameLanguageLocale } from "../localization/content-locale"
import { nowIso } from "../helpers"
import type { CommentListResponse } from "./comment-types"
import type { CommentWriteDraft } from "./community-comment-store"

async function enqueueCommentTranslationJob(input: {
  client: DbExecutor
  communityId: string
  commentId: string
  locale: string
  createdAt: string
  dedupe?: boolean
}): Promise<void> {
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "comment_translation_materialize",
    subjectType: "comment_translation",
    subjectId: `${input.commentId}:${input.locale}`,
    payloadJson: JSON.stringify({
      comment_id: input.commentId,
      locale: input.locale,
    }),
    createdAt: input.createdAt,
    dedupe: input.dedupe,
  })
}

export async function enqueueCommentTranslationPrewarmJobs(input: {
  client: DbExecutor
  communityId: string
  comment: CommentWriteDraft
  createdAt: string
  dedupe?: boolean
}): Promise<void> {
  if (input.comment.status !== "published" || !String(input.comment.body ?? "").trim()) {
    return
  }

  for (const locale of CONTENT_TRANSLATION_PREWARM_LOCALES) {
    if (sameLanguageLocale(input.comment.source_language, locale)) {
      continue
    }
    await enqueueCommentTranslationJob({
      client: input.client,
      communityId: input.communityId,
      commentId: input.comment.comment_id,
      locale,
      createdAt: input.createdAt,
      dedupe: input.dedupe,
    })
  }
}

export async function enqueueCommentTranslationOnReadIfNeeded(input: {
  client: Client
  communityId: string
  item: Pick<CommentListResponse["items"][number], "comment" | "resolved_locale" | "translation_state">
}): Promise<void> {
  if (input.item.translation_state !== "pending") {
    return
  }

  await enqueueCommentTranslationJob({
    client: input.client,
    communityId: input.communityId,
    commentId: input.item.comment.comment_id,
    locale: input.item.resolved_locale,
    createdAt: nowIso(),
  })
}

export async function localizeCommentItems(input: {
  client: Client
  communityId: string
  locale?: string | null
  items: CommentListResponse["items"]
}): Promise<CommentListResponse["items"]> {
  const localized = await Promise.all(input.items.map((item) => buildLocalizedCommentListItem({
    executor: input.client,
    item,
    locale: input.locale ?? null,
  })))

  await Promise.all(localized.map((item) => enqueueCommentTranslationOnReadIfNeeded({
    client: input.client,
    communityId: input.communityId,
    item,
  })))

  return localized
}
