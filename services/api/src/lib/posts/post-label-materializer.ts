import type { DbExecutor } from "../db-helpers"
import { listCommunityLabels } from "../communities/community-label-store"
import { nowIso } from "../helpers"
import { updatePostLabelAssignment } from "./community-post-store"
import { requestPostLabel } from "./post-label-provider"
import type { Env } from "../../env"
import type { Community, Post } from "../../types"

function hasLabelablePostContent(post: Pick<Post, "title" | "body" | "caption" | "link_url">): boolean {
  return Boolean(
    String(post.title ?? "").trim()
    || String(post.body ?? "").trim()
    || String(post.caption ?? "").trim()
    || String(post.link_url ?? "").trim()
  )
}

export async function materializePostLabel(input: {
  executor: DbExecutor
  env: Env
  community: Pick<Community, "community_id" | "display_name" | "label_policy">
  post: Post
}): Promise<string> {
  const now = nowIso()
  const labelPolicy = input.community.label_policy

  if (!labelPolicy?.label_enabled) {
    await updatePostLabelAssignment({
      executor: input.executor,
      postId: input.post.post_id,
      labelId: input.post.label_assigned_by === "moderator" ? input.post.label_id ?? null : null,
      assignmentStatus: "skipped",
      assignedBy: input.post.label_assigned_by ?? null,
      assignedAt: input.post.label_assigned_by === "moderator" ? input.post.label_assigned_at ?? null : null,
      aiConfidence: input.post.label_assigned_by === "moderator" ? input.post.label_ai_confidence ?? null : null,
      assignmentError: null,
      assignmentModel: null,
      assignmentResultJson: null,
      now,
    })
    return "skipped:disabled"
  }

  if (input.post.label_assigned_by === "moderator") {
    return "skipped:moderator_locked"
  }

  const labels = await listCommunityLabels({
    executor: input.executor,
    communityId: input.post.community_id,
    includeArchived: false,
  })

  if (labels.length === 0) {
    await updatePostLabelAssignment({
      executor: input.executor,
      postId: input.post.post_id,
      labelId: null,
      assignmentStatus: "skipped",
      assignedBy: null,
      assignedAt: null,
      aiConfidence: null,
      assignmentError: null,
      assignmentModel: null,
      assignmentResultJson: null,
      now,
    })
    return "skipped:no_definitions"
  }

  if (!hasLabelablePostContent(input.post)) {
    await updatePostLabelAssignment({
      executor: input.executor,
      postId: input.post.post_id,
      labelId: null,
      assignmentStatus: "skipped",
      assignedBy: null,
      assignedAt: null,
      aiConfidence: null,
      assignmentError: null,
      assignmentModel: null,
      assignmentResultJson: null,
      now,
    })
    return "skipped:no_content"
  }

  try {
    const labelResult = await requestPostLabel({
      env: input.env,
      community: {
        display_name: input.community.display_name,
      },
      post: {
        post_type: input.post.post_type,
        title: input.post.title ?? null,
        body: input.post.body ?? null,
        caption: input.post.caption ?? null,
        link_url: input.post.link_url ?? null,
      },
      labels: labels.map((label) => ({
        label_id: label.label_id,
        label: label.label,
        description: label.description,
      })),
    })

    const resolvedLabel = labels.find((label) => label.label_id === labelResult.labelId)
    if (!resolvedLabel) {
      throw new Error(`OpenRouter labeling returned unknown label_id ${labelResult.labelId}`)
    }

    await updatePostLabelAssignment({
      executor: input.executor,
      postId: input.post.post_id,
      labelId: resolvedLabel.label_id,
      assignmentStatus: "assigned",
      assignedBy: "ai",
      assignedAt: now,
      aiConfidence: labelResult.confidence,
      assignmentError: null,
      assignmentModel: labelResult.model,
      assignmentResultJson: labelResult.providerResult ? JSON.stringify(labelResult.providerResult) : null,
      now,
    })

    return `${resolvedLabel.label_id}:assigned`
  } catch (error) {
    await updatePostLabelAssignment({
      executor: input.executor,
      postId: input.post.post_id,
      labelId: input.post.label_id ?? null,
      assignmentStatus: "failed",
      assignedBy: input.post.label_assigned_by ?? null,
      assignedAt: input.post.label_assigned_at ?? null,
      aiConfidence: input.post.label_ai_confidence ?? null,
      assignmentError: error instanceof Error ? error.message : String(error),
      assignmentModel: null,
      assignmentResultJson: null,
      now,
    })
    throw error
  }
}
