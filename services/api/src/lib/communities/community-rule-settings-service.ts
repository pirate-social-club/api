import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { openCommunityDb } from "./community-db-factory"
import {
  loadCommunityProjection,
  communityMutationActorFromUserId,
  normalizeInputRules,
  requireAdminOverrideOrOwnedCommunity,
  type CommunityMutationActor,
  type UpdateCommunityRulesRequestBody,
} from "./create/shared"
import type {
  Community,
  Env,
} from "../../types"

type CommunitySettingsRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

export async function updateCommunityRules(input: {
  env: Env
  userId?: string
  actor?: CommunityMutationActor
  communityId: string
  body: UpdateCommunityRulesRequestBody
  communityRepository: CommunitySettingsRepository
}): Promise<Community> {
  await requireAdminOverrideOrOwnedCommunity({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor ?? communityMutationActorFromUserId(input.userId ?? ""),
    action: "community.rules_updated",
  })
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const rules = normalizeInputRules(input.body.rules)
    const now = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
        sql: `
          DELETE FROM community_rules
          WHERE community_id = ?1
        `,
        args: [input.communityId],
      })

      for (const [index, rule] of rules.entries()) {
        await tx.execute({
          sql: `
            INSERT INTO community_rules (
              rule_id, community_id, title, body, report_reason, position, status, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
            )
          `,
          args: [
            rule.rule_id,
            input.communityId,
            rule.title,
            rule.body,
            rule.report_reason,
            index,
            rule.status,
            now,
          ],
        })
      }

      await tx.execute({
        sql: `
          UPDATE communities
          SET updated_at = ?2
          WHERE community_id = ?1
        `,
        args: [input.communityId, now],
      })

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[community-rule-settings] rollback failed while updating rule settings", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }

  const updated = await input.communityRepository.getCommunityById(input.communityId)
  if (!updated) {
    throw notFoundError("Community not found")
  }
  return loadCommunityProjection(input.env, input.communityRepository, updated)
}
