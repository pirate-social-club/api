import {
  getCommentById,
  getCommunityVisibility,
  getLatestThreadSnapshot,
  insertThreadSnapshot,
  listThreadCommentsForSnapshot,
  updateCommentSwarmBodyRef,
} from "../../comments/community-comment-store"
import type { Comment } from "../../comments/comment-types"
import { internalError } from "../../errors"
import { nowIso } from "../../helpers"
import { getPostById } from "../../posts/community-post-query-store"
import {
  buildThreadFeedTopic,
  publishCollectionToSwarm,
  publishFeedReference,
  publishJsonToSwarm,
} from "../../swarm/swarm-publisher"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityJobHandlerInput } from "./handler-types"
import { parseJobPayload } from "./payload"
import { THREAD_SNAPSHOT_MIN_INTERVAL_MS } from "./runner-types"

type CommentBodyMirrorPayload = {
  comment_id?: string
  thread_root_post_id?: string
}

type ThreadSnapshotPayload = {
  thread_root_post_id?: string
}

function serializeSwarmComment(comment: Comment): Comment {
  if (comment.identity_mode !== "anonymous" && comment.authorship_mode !== "guest") {
    return comment
  }
  return {
    ...comment,
    author_user_id: null,
  }
}

export async function runCommentBodyMirror(input: CommunityJobHandlerInput): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<CommentBodyMirrorPayload>(input.job.payload_json)
    const commentId = payload?.comment_id ?? input.job.subject_id
    const comment = await getCommentById(db.client, commentId)
    if (!comment) {
      throw internalError("Comment is missing for swarm mirror")
    }
    if (comment.swarm_body_ref) {
      return comment.swarm_body_ref
    }

    const community = await getCommunityVisibility(db.client, input.job.community_id)
    if (!community || community.status !== "active") {
      throw internalError("Community is missing for swarm mirror")
    }
    if (String(community.membership_mode) !== "open") {
      return "skipped:non_public_community"
    }
    if (comment.status !== "published") {
      return `skipped:${comment.status}`
    }

    const result = await publishJsonToSwarm({
      env: input.env,
      path: `comments/${comment.comment_id}.json`,
      payload: {
        schema_version: 1,
        community_id: comment.community_id,
        thread_root_post_id: comment.thread_root_post_id,
        comment: serializeSwarmComment(comment),
      },
    })

    await updateCommentSwarmBodyRef({
      executor: db.client,
      commentId: comment.comment_id,
      swarmBodyRef: result.reference,
      now: nowIso(),
    })

    return result.reference
  } finally {
    db.close()
  }
}

export async function runThreadSnapshotPublish(input: CommunityJobHandlerInput): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<ThreadSnapshotPayload>(input.job.payload_json)
    const threadRootPostId = payload?.thread_root_post_id ?? input.job.subject_id
    const community = await getCommunityVisibility(db.client, input.job.community_id)
    if (!community || community.status !== "active") {
      throw internalError("Community is missing for thread snapshot publish")
    }
    if (String(community.membership_mode) !== "open") {
      return "skipped:non_public_community"
    }

    const post = await getPostById(db.client, threadRootPostId)
    if (!post) {
      throw internalError("Thread root post is missing for snapshot publish")
    }
    if (post.status !== "published") {
      return `skipped:${post.status}`
    }

    const latestSnapshot = await getLatestThreadSnapshot(db.client, threadRootPostId)
    if (
      latestSnapshot
      && Number.isFinite(Date.parse(latestSnapshot.created_at))
      && (Date.now() - Date.parse(latestSnapshot.created_at)) < THREAD_SNAPSHOT_MIN_INTERVAL_MS
    ) {
      return latestSnapshot.swarm_manifest_ref
    }

    const comments = await listThreadCommentsForSnapshot(db.client, threadRootPostId)
    const latestCommentCreatedAt = comments.at(-1)?.created_at ?? post.created_at
    if (
      latestSnapshot
      && latestSnapshot.comment_count === comments.length
      && latestSnapshot.published_through_comment_created_at === latestCommentCreatedAt
    ) {
      return latestSnapshot.swarm_manifest_ref
    }

    const snapshotSeq = (latestSnapshot?.snapshot_seq ?? 0) + 1
    const result = await publishCollectionToSwarm({
      env: input.env,
      indexDocument: "thread.json",
      files: [
        {
          path: "thread.json",
          payload: {
            schema_version: 1,
            community_id: input.job.community_id,
            thread_root_post_id: threadRootPostId,
            snapshot_seq: snapshotSeq,
            comment_count: comments.length,
            published_through_comment_created_at: latestCommentCreatedAt,
            post,
            comments: comments.map((comment) => ({
              comment_id: comment.comment_id,
              path: `comments/${comment.comment_id}.json`,
              swarm_body_ref: comment.swarm_body_ref,
              parent_comment_id: comment.parent_comment_id,
              depth: comment.depth,
              created_at: comment.created_at,
            })),
          },
        },
        ...comments.map((comment) => ({
          path: `comments/${comment.comment_id}.json`,
          payload: serializeSwarmComment(comment),
        })),
      ],
    })

    let swarmFeedRef = latestSnapshot?.swarm_feed_ref ?? null
    if (String(input.env.SWARM_FEED_PRIVATE_KEY || "").trim()) {
      const topic = buildThreadFeedTopic({
        env: input.env,
        communityId: input.job.community_id,
        threadRootPostId,
      })
      const feed = await publishFeedReference({
        env: input.env,
        topic,
        reference: result.reference,
      })
      swarmFeedRef = feed.feedReference
    }

    await insertThreadSnapshot({
      executor: db.client,
      communityId: input.job.community_id,
      threadRootPostId,
      snapshotSeq,
      publishedThroughCommentCreatedAt: latestCommentCreatedAt,
      commentCount: comments.length,
      swarmManifestRef: result.reference,
      swarmFeedRef,
      createdAt: nowIso(),
    })

    return result.reference
  } finally {
    db.close()
  }
}
