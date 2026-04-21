import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "./db-community-repository"
import { internalError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { openCommunityDb } from "./community-db-factory"
import {
  assertPublicV0GateConfiguration,
  assertUpdateCommunityGatesRequest,
  loadCommunityProjection,
  requireOwnedCommunity,
  type UpdateCommunityGatesRequestBody,
} from "./create/shared"
import type {
  Community,
  Env,
} from "../../types"

export async function updateCommunityGates(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityGatesRequestBody | null
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<Community> {
  assertUpdateCommunityGatesRequest(input.body)
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)

  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community gates update")
  }

  assertPublicV0GateConfiguration(input.body, {
    ageOver18Verified: user.verification_capabilities.age_over_18.state === "verified",
  })

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const now = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
        sql: `
          UPDATE communities
          SET membership_mode = ?2,
              default_age_gate_policy = ?3,
              allow_anonymous_identity = ?4,
              anonymous_identity_scope = ?5,
              updated_at = ?6
          WHERE community_id = ?1
        `,
        args: [
          input.communityId,
          input.body.membership_mode,
          input.body.default_age_gate_policy ?? "none",
          input.body.allow_anonymous_identity ? 1 : 0,
          input.body.allow_anonymous_identity ? (input.body.anonymous_identity_scope ?? null) : null,
          now,
        ],
      })

      await tx.execute({
        sql: `
          DELETE FROM community_gate_rules
          WHERE community_id = ?1
        `,
        args: [input.communityId],
      })

      for (const [index, rule] of (input.body.gate_rules ?? []).entries()) {
        const existingId = typeof rule.gate_rule_id === "string" && rule.gate_rule_id.trim().length > 0
          ? rule.gate_rule_id.trim()
          : null
        const gateRuleId = existingId ?? `grl_${input.communityId}_${index}_${nowIso().replace(/[^a-zA-Z0-9]/g, "")}_${index}`
        await tx.execute({
          sql: `
            INSERT INTO community_gate_rules (
              gate_rule_id, community_id, scope, gate_family, gate_type, proof_requirements_json,
              chain_namespace, gate_config_json, status, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6,
              ?7, ?8, 'active', ?9, ?9
            )
          `,
          args: [
            gateRuleId,
            input.communityId,
            rule.scope,
            rule.gate_family,
            rule.gate_type,
            rule.proof_requirements ? JSON.stringify(rule.proof_requirements) : null,
            rule.chain_namespace ?? null,
            rule.gate_config ? JSON.stringify(rule.gate_config) : null,
            now,
          ],
        })
      }

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
