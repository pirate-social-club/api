import type { Env } from "../../env"
import { conflictError, notFoundError, providerUnavailable } from "../errors"
import { makeId, nowIso } from "../helpers"
import { safeRollback } from "../transactions"
import { openCommunityWriteClient } from "../communities/community-read-access"
import type { CommunityJobRepository } from "../communities/jobs/runner-types"
import { getAssetRow } from "../communities/commerce/queries"
import { classifyStoryRegistrationFailure } from "../communities/commerce/story-registration-failure"
import { assertStoryRuntimeSignerFunding } from "../story/story-runtime-funding"
import { resolveStoryRuntimeSignerTargetBalanceWei } from "../story/story-runtime-config"
import { getPostById } from "./community-post-query-store"
import type { Post } from "../../types"
import type { AssetRow } from "../communities/commerce/row-types"

export type OperatorBlockedPublishRecoveryOutcome = {
  outcome: "requeued"
  jobId: string
  postId: string
}

export function isOperatorBlockedPostPublish(input: {
  post: Pick<Post, "asset_id" | "post_id" | "publish_failure_code" | "status">
  asset: Pick<AssetRow, "asset_id" | "source_post_id" | "story_error"> | null
}): boolean {
  const asset = input.asset
  return asset !== null
    && input.post.status === "failed"
    && input.post.publish_failure_code === "story_royalty_registration_failed"
    && Boolean(input.post.asset_id)
    && asset.asset_id === input.post.asset_id
    && asset.source_post_id === input.post.post_id
    && classifyStoryRegistrationFailure(asset.story_error) === "insufficient_funds"
}

/**
 * Requeues a publish that was terminal only because the platform-owned Story
 * signer was underfunded. User retries remain disabled: a scoped operator must
 * first restore the enforced funding target, then invoke this guarded action.
 */
export async function recoverOperatorBlockedPostPublish(input: {
  env: Env
  communityRepository: CommunityJobRepository
  communityId: string
  postId: string
}): Promise<OperatorBlockedPublishRecoveryOutcome> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const post = await getPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) throw notFoundError("Post not found")
    if (!post.asset_id) throw conflictError("Blocked post has no Story asset")

    const asset = await getAssetRow(db.client, input.communityId, post.asset_id)
    if (!isOperatorBlockedPostPublish({ post, asset })) {
      throw conflictError("Post is not blocked on Story operator funding")
    }

    try {
      await assertStoryRuntimeSignerFunding(input.env, [{
        name: "story-operator",
        minBalanceWei: resolveStoryRuntimeSignerTargetBalanceWei(input.env),
      }])
    } catch {
      throw providerUnavailable(
        "Story operator funding has not recovered",
        { reason: "operator_funding_still_blocked" },
        false,
      )
    }

    const recoveredAt = nowIso()
    const jobId = makeId("cjb")
    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
        sql: `
          UPDATE posts
          SET status = 'processing',
              publish_failure_code = NULL,
              publish_failure_message = NULL,
              publish_failure_retryable = NULL,
              publish_failed_at = NULL,
              updated_at = ?2
          WHERE post_id = ?1
            AND status = 'failed'
            AND publish_failure_code = 'story_royalty_registration_failed'
        `,
        args: [post.post_id, recoveredAt],
      })
      await tx.execute({
        sql: `
          UPDATE post_publish_requests
          SET status = 'pending',
              failure_code = NULL,
              failure_message = NULL,
              updated_at = ?3
          WHERE community_id = ?1
            AND post_id = ?2
            AND EXISTS (
              SELECT 1 FROM posts
              WHERE posts.post_id = ?2
                AND posts.status = 'processing'
                AND posts.updated_at = ?3
            )
        `,
        args: [input.communityId, post.post_id, recoveredAt],
      })
      await tx.execute({
        sql: `
          INSERT INTO community_jobs (
            job_id, community_id, job_type, subject_type, subject_id, status, payload_json,
            result_ref, error_code, attempt_count, available_at, last_checkpoint, last_checkpoint_at,
            attempt_started_at, attempt_deadline_at, created_at, updated_at
          )
          SELECT ?1, ?2, 'post_publish_finalize', 'post', ?3, 'queued', ?4,
                 NULL, NULL, 0, NULL, NULL, NULL,
                 NULL, NULL, ?5, ?5
          WHERE EXISTS (
            SELECT 1 FROM posts
            WHERE posts.post_id = ?3
              AND posts.status = 'processing'
              AND posts.updated_at = ?5
          )
        `,
        args: [jobId, input.communityId, post.post_id, JSON.stringify({ post_id: post.post_id }), recoveredAt],
      })
      await tx.commit()
    } catch (error) {
      await safeRollback(tx, "[operator-blocked-publish] rollback failed")
      throw error
    } finally {
      tx.close()
    }

    const updated = await getPostById(db.client, post.post_id)
    if (!updated) throw notFoundError("Post not found after publish recovery")
    if (updated.status !== "processing" || updated.updated_at !== recoveredAt) {
      throw conflictError("Post publish state changed before recovery")
    }
    await input.communityRepository.updateCommunityPostProjectionStatus({
      postId: post.post_id,
      status: "processing",
      updatedAt: recoveredAt,
    })
    await input.communityRepository.updateCommunityPostProjectionPayload({
      postId: post.post_id,
      projectedPayloadJson: JSON.stringify(updated),
      updatedAt: recoveredAt,
    })
    return { outcome: "requeued", jobId, postId: post.post_id }
  } finally {
    db.close()
  }
}
