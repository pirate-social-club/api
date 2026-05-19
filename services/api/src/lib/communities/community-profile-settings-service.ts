import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { openCommunityDb } from "./community-db-factory"
import { syncCommunityAuthProjection } from "./community-auth-projection-service"
import {
  assertUpdateCommunityRequest,
  communityMutationActorFromUserId,
  loadCommunityProjection,
  parseCommunitySettingsJson,
  requireAdminOverrideOrOwnedCommunity,
  type CommunityMutationActor,
  type UpdateCommunityRequestBody,
} from "./create/shared"
import type {
  Community,
  Env,
} from "../../types"

type CommunitySettingsRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

export async function updateCommunity(input: {
  env: Env
  userId?: string
  actor?: CommunityMutationActor
  communityId: string
  body: UpdateCommunityRequestBody | null
  communityRepository: CommunitySettingsRepository
}): Promise<Community> {
  assertUpdateCommunityRequest(input.body)
  await requireAdminOverrideOrOwnedCommunity({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor ?? communityMutationActorFromUserId(input.userId ?? ""),
    action: "community.profile_updated",
  })
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const result = await db.client.execute({
      sql: `
        SELECT settings_json, display_name, description, avatar_ref, banner_ref
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    const existingSettings = parseCommunitySettingsJson(row?.settings_json)
    const nextSettings: Record<string, unknown> = {
      ...existingSettings,
    }
    const nextDisplayName =
      "display_name" in input.body
        ? (input.body.display_name?.trim() || String(row?.display_name ?? ""))
        : String(row?.display_name ?? "")
    const nextDescription =
      "description" in input.body
        ? (input.body.description?.trim() || null)
        : (row?.description == null ? null : String(row.description))
    const nextAvatarRef =
      "avatar_ref" in input.body
        ? (input.body.avatar_ref?.trim() || null)
        : (row?.avatar_ref == null ? null : String(row.avatar_ref))
    const nextBannerRef =
      "banner_ref" in input.body
        ? (input.body.banner_ref?.trim() || null)
        : (row?.banner_ref == null ? null : String(row.banner_ref))

    if ("agent_posting_policy" in input.body) {
      nextSettings.agent_posting_policy = input.body.agent_posting_policy ?? null
    }
    if ("guest_comment_policy" in input.body) {
      nextSettings.guest_comment_policy = input.body.guest_comment_policy ?? null
    }
    if ("agent_posting_scope" in input.body) {
      nextSettings.agent_posting_scope = input.body.agent_posting_scope ?? null
    }
    if ("agent_daily_post_cap" in input.body) {
      nextSettings.agent_daily_post_cap = input.body.agent_daily_post_cap ?? null
    }
    if ("agent_daily_reply_cap" in input.body) {
      nextSettings.agent_daily_reply_cap = input.body.agent_daily_reply_cap ?? null
    }
    if ("human_verification_lane" in input.body) {
      nextSettings.human_verification_lane = input.body.human_verification_lane ?? null
    }
    if ("accepted_agent_ownership_providers" in input.body) {
      nextSettings.accepted_agent_ownership_providers = input.body.accepted_agent_ownership_providers == null
        ? null
        : [...new Set(input.body.accepted_agent_ownership_providers)]
    }
    if ("store_url" in input.body) {
      nextSettings.store_url = input.body.store_url?.trim() || null
    }
    if ("store_label" in input.body) {
      nextSettings.store_label = input.body.store_label?.trim() || null
    }

    const now = nowIso()
    await db.client.execute({
      sql: `
        UPDATE communities
        SET display_name = ?2,
            description = ?3,
            avatar_ref = ?4,
            banner_ref = ?5,
            settings_json = ?6,
            updated_at = ?7
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        nextDisplayName,
        nextDescription,
        nextAvatarRef,
        nextBannerRef,
        JSON.stringify(nextSettings),
        now,
      ],
    })
    await syncCommunityAuthProjection({
      env: input.env,
      communityId: input.communityId,
      displayName: nextDisplayName,
      avatarRef: nextAvatarRef,
      updatedAt: now,
    })
  } finally {
    db.close()
  }

  const updated = await input.communityRepository.getCommunityById(input.communityId)
  if (!updated) {
    throw notFoundError("Community not found")
  }

  return loadCommunityProjection(input.env, input.communityRepository, updated)
}
