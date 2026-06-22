import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { withTransaction } from "../transactions"
import { openCommunityWriteClient } from "./community-read-access"
import {
  loadCommunityProjection,
  communityMutationActorFromUserId,
  normalizeInputRules,
  requireAdminOverrideOrOwnedCommunity,
  type CommunityMutationActor,
  type UpdateCommunityRulesRequestBody,
} from "./create/shared"
import type { Client } from "../sql-client"
import type {
  Community,
  Env,
} from "../../types"

type CommunitySettingsRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

/**
 * Write-only rule-settings mutation, isolated for buffer-safety testing. The tx
 * body issues ONLY writes (DELETE + INSERT loop + UPDATE) so it is safe inside
 * the routed D1 buffering tx, which flushes the whole tx as one atomic
 * shard.batchWrite where reads are rejected. Validation/normalization happen in
 * the caller before this runs; there is no in-tx read or readback.
 * See [d1-buffered-write-tx-select-trap].
 */
export async function updateCommunityRulesOnClient(
  client: Pick<Client, "transaction">,
  input: {
    communityId: string
    rules: ReturnType<typeof normalizeInputRules>
    now: string
  },
): Promise<void> {
  await withTransaction(client, "write", async (tx) => {
    await tx.execute({
      sql: `
        DELETE FROM community_rules
        WHERE community_id = ?1
      `,
      args: [input.communityId],
    })

    for (const [index, rule] of input.rules.entries()) {
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
          input.now,
        ],
      })
    }

    await tx.execute({
      sql: `
        UPDATE communities
        SET updated_at = ?2
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.now],
    })

  })
}

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
  // Routed write surface (buffer-safe, write-only tx body): D1 for backend='d1'
  // communities, legacy Turso otherwise. As of §8.8 all consumer surfaces are
  // routed through the read/write clients; the only remaining openCommunityDb is
  // the read/write clients' internal Turso fallback (removed in Phase 5).
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)

  try {
    await updateCommunityRulesOnClient(db.client, {
      communityId: input.communityId,
      rules: normalizeInputRules(input.body.rules),
      now: nowIso(),
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
