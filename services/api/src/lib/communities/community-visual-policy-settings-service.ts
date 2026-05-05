import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { openCommunityDb } from "./community-db-factory"
import {
  assertUpdateCommunityVisualPolicyRequest,
  communityMutationActorFromUserId,
  loadCommunityProjection,
  parseCommunitySettingsJson,
  requireAdminOverrideOrOwnedCommunity,
  type CommunityMutationActor,
  type UpdateCommunityVisualPolicyRequestBody,
} from "./create/shared"
import type {
  Community,
  Env,
} from "../../types"

type CommunitySettingsRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

export async function updateCommunityVisualPolicy(input: {
  env: Env
  userId?: string
  actor?: CommunityMutationActor
  communityId: string
  body: UpdateCommunityVisualPolicyRequestBody | null
  communityRepository: CommunitySettingsRepository
}): Promise<Community> {
  assertUpdateCommunityVisualPolicyRequest(input.body)
  await requireAdminOverrideOrOwnedCommunity({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor ?? communityMutationActorFromUserId(input.userId ?? ""),
    action: "community.visual_policy_updated",
  })
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const result = await db.client.execute({
      sql: `
        SELECT settings_json
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
      visual_policy_settings: {
        community: `com_${input.communityId}`,
        policy_origin: "explicit" as const,
        ...input.body.visual_policy_settings,
      },
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
