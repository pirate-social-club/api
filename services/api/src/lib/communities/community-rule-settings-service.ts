import type { CommunityRepository } from "./db-community-repository"
import { notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { openCommunityDb } from "./community-db-factory"
import {
  loadCommunityProjection,
  normalizeInputRules,
  requireOwnedCommunity,
  type UpdateCommunityRulesRequestBody,
} from "./community-create-shared"
import type {
  Community,
  Env,
} from "../../types"

export async function updateCommunityRules(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityRulesRequestBody
  communityRepository: CommunityRepository
}): Promise<Community> {
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
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
      } catch {}
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
