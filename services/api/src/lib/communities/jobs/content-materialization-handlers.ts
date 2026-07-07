import { getCommentById } from "../../comments/community-comment-store"
import { internalError } from "../../errors"
import { materializeCommentTranslation } from "../../localization/comment-translation-materializer"
import {
  materializeCommunityTextTranslations,
  parseCommunityTextMaterializePayload,
} from "../../localization/community-localization-service"
import { materializePostTranslation } from "../../localization/post-translation-materializer"
import { getPostById } from "../../posts/community-post-query-store"
import { materializePostLabel } from "../../posts/post-label-materializer"
import { schedulePublicPostCachePurge } from "../../public-read-cache-invalidation"
import { loadCommunityProjection } from "../create/service"
import { openCommunityWriteClient } from "../community-read-access"
import type { CommunityJobHandlerInput } from "./handler-types"
import { parseJobPayload } from "./payload"

type PostTranslationPayload = {
  post_id?: string
  locale?: string | null
}

type PostLabelPayload = {
  post_id?: string
  reason?: "publish" | "edit"
}

type CommentTranslationPayload = {
  comment_id?: string
  locale?: string | null
}

type CommunityTextTranslationPayload = {
  locale?: string | null
}

function translationResultMutatedPublicRead(result: string | null): boolean {
  if (!result) {
    return false
  }
  return !result.startsWith("cached:")
    && !result.startsWith("skipped:")
}

export async function runPostTranslationMaterialize(input: CommunityJobHandlerInput): Promise<string | null> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<PostTranslationPayload>(input.job.payload_json)
    const postId = payload?.post_id ?? input.job.subject_id.split(":")[0] ?? input.job.subject_id
    const locale = payload?.locale ?? null
    const post = await getPostById(db.client, postId)
    if (!post) {
      throw internalError("Post is missing for translation materialize")
    }
    const result = await materializePostTranslation({
      executor: db.client,
      env: input.env,
      post,
      locale,
    })
    if (translationResultMutatedPublicRead(result)) {
      await schedulePublicPostCachePurge({
        env: input.env,
        communityId: input.job.community_id,
        postId,
      })
    }
    return result
  } finally {
    db.close()
  }
}

export async function runPostLabelMaterialize(input: CommunityJobHandlerInput): Promise<string | null> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<PostLabelPayload>(input.job.payload_json)
    const postId = payload?.post_id ?? input.job.subject_id
    const post = await getPostById(db.client, postId)
    if (!post) {
      throw internalError("Post is missing for label materialize")
    }

    const communityRow = await input.communityRepository.getCommunityById(input.job.community_id)
    if (!communityRow) {
      throw internalError("Community is missing for label materialize")
    }

    const community = await loadCommunityProjection(
      input.env,
      input.communityRepository,
      communityRow,
    )

    return await materializePostLabel({
      executor: db.client,
      env: input.env,
      community,
      post,
    })
  } finally {
    db.close()
  }
}

export async function runCommentTranslationMaterialize(input: CommunityJobHandlerInput): Promise<string | null> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<CommentTranslationPayload>(input.job.payload_json)
    const commentId = payload?.comment_id ?? input.job.subject_id.split(":")[0] ?? input.job.subject_id
    const locale = payload?.locale ?? null
    const comment = await getCommentById(db.client, commentId)
    if (!comment) {
      throw internalError("Comment is missing for translation materialize")
    }
    const result = await materializeCommentTranslation({
      executor: db.client,
      env: input.env,
      comment,
      locale,
    })
    if (translationResultMutatedPublicRead(result)) {
      await schedulePublicPostCachePurge({
        env: input.env,
        communityId: input.job.community_id,
        postId: comment.thread_root_post_id,
      })
    }
    return result
  } finally {
    db.close()
  }
}

export async function runCommunityTextTranslationMaterialize(input: CommunityJobHandlerInput): Promise<string | null> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseCommunityTextMaterializePayload(input.job.payload_json) as CommunityTextTranslationPayload | null
    const locale = payload?.locale ?? null
    const communityRow = await input.communityRepository.getCommunityById(input.job.community_id)
    if (!communityRow) {
      throw internalError("Community is missing for text translation materialize")
    }

    const community = await loadCommunityProjection(
      input.env,
      input.communityRepository,
      communityRow,
    )
    return await materializeCommunityTextTranslations({
      executor: db.client,
      env: input.env,
      community,
      locale,
    })
  } finally {
    db.close()
  }
}
