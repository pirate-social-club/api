import { nowIso } from "../helpers"
import { listRecentPostsForProjectionReconcile } from "../posts/community-post-store"
import type { Env } from "../../types"
import { openCommunityDb } from "./community-db-factory"
import type { CommunityRepository } from "./control-plane-community-repository"

function parsePositiveInt(value: string | null | undefined, fallback: number): number {
  const parsed = Number(String(value ?? "").trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.max(1, Math.trunc(parsed))
}

export function parseCommunityPostProjectionReconcileLimit(value: string | null | undefined, env: Env): number {
  return parsePositiveInt(value ?? env.COMMUNITY_POST_PROJECTION_RECONCILE_LIMIT, 10)
}

export async function reconcileRecentCommunityPostProjections(input: {
  env: Env
  limit: number
  communityRepository: CommunityRepository
}): Promise<{
  scanned_count: number
  reconciled_count: number
  created_count: number
  updated_count: number
}> {
  const communities = await input.communityRepository.listActiveCommunities()
  const counts = {
    scanned_count: 0,
    reconciled_count: 0,
    created_count: 0,
    updated_count: 0,
  }

  let remaining = Math.max(1, Math.trunc(input.limit))
  for (const community of communities) {
    if (remaining <= 0) {
      break
    }

    const db = await openCommunityDb(input.communityRepository, community.community_id)
    try {
      const posts = await listRecentPostsForProjectionReconcile({
        client: db.client,
        limit: remaining,
      })
      counts.scanned_count += posts.length

      for (const post of posts) {
        if (remaining <= 0) {
          break
        }

        const projectedPayloadJson = JSON.stringify(post)
        const projection = await input.communityRepository.getCommunityPostProjectionByPostId(post.post_id)
        if (projection?.status === post.status && projection.projected_payload_json === projectedPayloadJson) {
          remaining -= 1
          continue
        }

        await input.communityRepository.reconcileCommunityPostProjection({
          communityId: post.community_id,
          sourcePostId: post.post_id,
          authorUserId: post.author_user_id ?? null,
          identityMode: post.identity_mode,
          postType: post.post_type,
          status: post.status,
          sourceCreatedAt: post.created_at,
          projectedPayloadJson,
          updatedAt: nowIso(),
        })

        counts.reconciled_count += 1
        if (projection) {
          counts.updated_count += 1
        } else {
          counts.created_count += 1
        }
        remaining -= 1
      }
    } finally {
      db.close()
    }
  }

  return counts
}
