import type { CommunityRepository } from "./db-community-repository"
import { notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { openCommunityDb } from "./community-db-factory"
import {
  assertUpdateCommunitySafetyRequest,
  loadCommunityProjection,
  parseCommunitySettingsJson,
  requireOwnedCommunity,
  type UpdateCommunitySafetyRequestBody,
} from "./community-create-shared"
import type {
  Community,
  Env,
} from "../../types"

export async function updateCommunitySafety(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunitySafetyRequestBody | null
  communityRepository: CommunityRepository
}): Promise<Community> {
  assertUpdateCommunitySafetyRequest(input.body)
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const result = await db.client.execute({
      sql: `
        SELECT display_name, description, avatar_ref, banner_ref, settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    const existingSettings = parseCommunitySettingsJson(row?.settings_json)
    const now = nowIso()

    const settings = {
      ...existingSettings,
      adult_content_policy: {
        community_id: input.communityId,
        policy_origin: "explicit" as const,
        updated_at: now,
        ...input.body.adult_content_policy,
      },
      graphic_content_policy: {
        community_id: input.communityId,
        policy_origin: "explicit" as const,
        updated_at: now,
        ...input.body.graphic_content_policy,
      },
      civility_policy: {
        community_id: input.communityId,
        policy_origin: "explicit" as const,
        updated_at: now,
        ...input.body.civility_policy,
      },
      openai_moderation_settings: input.body.openai_moderation_settings,
    }

    await db.client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, JSON.stringify(settings), now],
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
