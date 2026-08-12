import type { Client } from "../sql-client"
import type { DbExecutor } from "../db-helpers"
import { enqueueCommunityJob, type CommunityJobRow } from "../communities/jobs/store"
import { COMMUNITY_JOB_MAX_ATTEMPTS } from "../communities/jobs/runner-types"
import { buildLocalizedCommentListItem } from "../localization/comment-localization-service"
import { CONTENT_TRANSLATION_PREWARM_LOCALES, sameLanguageLocale } from "../localization/content-locale"
import { computeCommentSourceHash } from "../localization/content-source-hash"
import { nowIso } from "../helpers"
import type { ProfileRepository } from "../auth/repositories"
import { hydrateCommentAuthorPublicHandles } from "./comment-author-hydration"
import type { CommentListResponse } from "./comment-types"
import type { CommentWriteDraft } from "./community-comment-store"

async function enqueueCommentTranslationJob(input: {
  client: DbExecutor
  communityId: string
  commentId: string
  locale: string
  sourceHash: string
  createdAt: string
  dedupe?: boolean
}): Promise<CommunityJobRow> {
  return await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "comment_translation_materialize",
    subjectType: "comment_translation",
    subjectId: `${input.commentId}:${input.locale}:${input.sourceHash}`,
    payloadJson: JSON.stringify({
      comment_id: input.commentId,
      locale: input.locale,
      source_hash: input.sourceHash,
    }),
    createdAt: input.createdAt,
    dedupe: input.dedupe,
    reuseTerminalFailure: true,
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
  const sourceHash = await computeCommentSourceHash(input.comment)

  for (const locale of CONTENT_TRANSLATION_PREWARM_LOCALES) {
    if (sameLanguageLocale(input.comment.source_language, locale)) {
      continue
    }
    await enqueueCommentTranslationJob({
      client: input.client,
      communityId: input.communityId,
      commentId: input.comment.comment_id,
      locale,
      sourceHash,
      createdAt: input.createdAt,
      dedupe: input.dedupe,
    })
  }
}

export async function enqueueCommentTranslationOnReadIfNeeded(input: {
  client: Client
  communityId: string
  item: Pick<CommentListResponse["items"][number], "comment" | "resolved_locale" | "translation_state" | "source_hash">
}): Promise<void> {
  if (input.item.translation_state !== "pending") {
    return
  }

  const job = await enqueueCommentTranslationJob({
    client: input.client,
    communityId: input.communityId,
    commentId: input.item.comment.comment_id,
    locale: input.item.resolved_locale,
    sourceHash: input.item.source_hash,
    createdAt: nowIso(),
  })
  if (job.status === "failed" && job.attempt_count >= COMMUNITY_JOB_MAX_ATTEMPTS) {
    input.item.translation_state = "failed"
  }
}

export async function localizeCommentItems(input: {
  client: Client
  communityId: string
  locale?: string | null
  items: CommentListResponse["items"]
  profileRepository?: ProfileRepository | null
}): Promise<CommentListResponse["items"]> {
  const localized = await Promise.all(input.items.map((item) => buildLocalizedCommentListItem({
    executor: input.client,
    item,
    locale: input.locale ?? null,
  })))

  await hydrateCommentAuthorPublicHandles(localized, input.profileRepository, {
    kind: "community",
    client: input.client,
    communityId: input.communityId,
  })

  await Promise.all(localized.map((item) => enqueueCommentTranslationOnReadIfNeeded({
    client: input.client,
    communityId: input.communityId,
    item,
  })))

  return localized
}
