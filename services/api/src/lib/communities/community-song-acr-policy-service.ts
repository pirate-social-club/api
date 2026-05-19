import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { notFoundError, eligibilityFailed } from "../errors"
import { nowIso } from "../helpers"
import { openCommunityDb } from "./community-db-factory"
import {
  loadCommunityProjection,
  parseCommunitySettingsJson,
  type CommunityMutationActor,
} from "./create/shared"
import type {
  Community,
  Env,
} from "../../types"

export type CommunitySongAcrPolicy = "standard" | "skip_for_trusted_uploaders"

type CommunitySettingsRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

export function normalizeCommunitySongAcrPolicy(value: unknown): CommunitySongAcrPolicy {
  return value === "skip_for_trusted_uploaders" ? "skip_for_trusted_uploaders" : "standard"
}

export function shouldSkipAcrForCommunitySettings(settings: Record<string, unknown>): boolean {
  return normalizeCommunitySongAcrPolicy(settings.song_acr_policy) === "skip_for_trusted_uploaders"
}

export async function shouldSkipAcrForCommunity(input: {
  env: Env
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<boolean> {
  return (await getCommunitySongAcrPolicy(input)) === "skip_for_trusted_uploaders"
}

export async function getCommunitySongAcrPolicy(input: {
  env: Env
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<CommunitySongAcrPolicy> {
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
    const settings = parseCommunitySettingsJson(result.rows[0]?.settings_json)
    return normalizeCommunitySongAcrPolicy(settings.song_acr_policy)
  } finally {
    db.close()
  }
}

export async function updateCommunitySongAcrPolicy(input: {
  env: Env
  actor: CommunityMutationActor
  communityId: string
  songAcrPolicy: CommunitySongAcrPolicy
  communityRepository: CommunitySettingsRepository
}): Promise<Community> {
  if (!("adminOverride" in input.actor)) {
    throw eligibilityFailed("Only platform operators can update community song ACR policy")
  }

  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }

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
    const existingSettings = parseCommunitySettingsJson(result.rows[0]?.settings_json)
    const now = nowIso()
    const settings = {
      ...existingSettings,
      song_acr_policy: input.songAcrPolicy,
      song_acr_policy_updated_at: now,
      song_acr_policy_updated_by: input.actor.adminOverride.adminActorId,
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
