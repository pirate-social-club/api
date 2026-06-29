import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { badRequestError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { writeAuditEventForEnv } from "../audit"
import { openCommunityReadClient, openCommunityWriteClient } from "./community-read-access"
import {
  communityMutationActorFromUserId,
  requireOwnedCommunity,
  type CommunityMutationActor,
} from "./create/shared"
import type { CommunityRow } from "../auth/auth-db-rows"
import type { Client } from "../sql-client"
import type { DbExecutor } from "../db-helpers"
import type { Env } from "../../types"

type CommunityStudyPolicyRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

export type CommunityStudyPolicy = {
  community_id: string
  study_enabled: boolean
  updated_at: string | null
}

export type CommunityStudyPolicyPatch = {
  study_enabled?: boolean
}

type CommunityColumnClient = Pick<Client, "execute">

async function hasCommunityColumn(client: CommunityColumnClient | DbExecutor, columnName: string): Promise<boolean> {
  const result = await client.execute("PRAGMA table_info(communities)")
  return result.rows.some((row) => String(row.name) === columnName)
}

function defaultCommunityStudyPolicy(input: {
  communityId: string
  updatedAt?: string | null
}): CommunityStudyPolicy {
  return {
    community_id: input.communityId,
    study_enabled: false,
    updated_at: input.updatedAt ?? null,
  }
}

function toCommunityStudyPolicy(input: {
  communityId: string
  row: Record<string, unknown> | undefined
}): CommunityStudyPolicy {
  const row = input.row
  if (!row) {
    return defaultCommunityStudyPolicy({ communityId: input.communityId })
  }

  return {
    community_id: input.communityId,
    study_enabled: Number(row.study_enabled ?? 0) === 1,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
  }
}

async function ensureCommunityStudyPolicyColumn(client: CommunityColumnClient): Promise<void> {
  if (!await hasCommunityColumn(client, "study_enabled")) {
    await client.execute("ALTER TABLE communities ADD COLUMN study_enabled INTEGER NOT NULL DEFAULT 0 CHECK (study_enabled IN (0, 1))")
  }
}

async function ensureCommunityStudyPolicyRow(input: {
  client: Client
  community: CommunityRow
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, display_name, description, status, artist_identity_id,
        artist_governance_state, membership_mode, default_age_gate_policy, allow_anonymous_identity,
        anonymous_identity_scope, donation_partner_id, donation_policy_mode, donation_partner_status,
        governance_mode, settings_json, created_by_user_id, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'active', NULL,
        'fan_run', 'open', 'none', 0,
        NULL, NULL, 'none', 'unconfigured',
        'centralized', NULL, ?4, ?5, ?5
      )
      ON CONFLICT(community_id) DO NOTHING
    `,
    args: [
      input.community.community_id,
      input.community.display_name,
      input.community.description,
      input.community.creator_user_id,
      input.community.created_at || input.now,
    ],
  })
}

export async function isCommunityStudyEnabled(input: {
  executor: DbExecutor
  communityId: string
}): Promise<boolean> {
  if (!await hasCommunityColumn(input.executor, "study_enabled")) {
    return false
  }
  const result = await input.executor.execute({
    sql: `
      SELECT study_enabled
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [input.communityId],
  })
  return Number(result.rows[0]?.study_enabled ?? 0) === 1
}

function assertCommunityStudyPolicyPatch(body: CommunityStudyPolicyPatch | null): CommunityStudyPolicyPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequestError("Invalid community study policy payload")
  }
  if (!("study_enabled" in body)) {
    throw badRequestError("study_enabled is required")
  }
  if (typeof body.study_enabled !== "boolean") {
    throw badRequestError("study_enabled must be a boolean")
  }
  return body
}

async function readCommunityStudyPolicy(input: {
  env: Env
  communityRepository: CommunityStudyPolicyRepository
  communityId: string
}): Promise<CommunityStudyPolicy> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    if (!await hasCommunityColumn(db.client, "study_enabled")) {
      const legacy = await db.client.execute({
        sql: `
          SELECT updated_at
          FROM communities
          WHERE community_id = ?1
          LIMIT 1
        `,
        args: [input.communityId],
      })
      return defaultCommunityStudyPolicy({
        communityId: input.communityId,
        updatedAt: typeof legacy.rows[0]?.updated_at === "string" ? legacy.rows[0].updated_at : null,
      })
    }

    const result = await db.client.execute({
      sql: `
        SELECT study_enabled, updated_at
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    return toCommunityStudyPolicy({
      communityId: input.communityId,
      row: result.rows[0],
    })
  } finally {
    db.close()
  }
}

async function requireStudyPolicyCommunity(input: {
  communityRepository: CommunityStudyPolicyRepository
  communityId: string
  actor: CommunityMutationActor
}): Promise<CommunityRow> {
  if ("adminOverride" in input.actor) {
    const community = await input.communityRepository.getCommunityById(input.communityId)
    if (!community) {
      throw notFoundError("Community not found")
    }
    return community
  }

  return requireOwnedCommunity(input.communityRepository, input.communityId, input.actor.userId)
}

export async function getCommunityStudyPolicy(input: {
  env: Env
  communityRepository: CommunityStudyPolicyRepository
  communityId: string
  actor: CommunityMutationActor
}): Promise<CommunityStudyPolicy> {
  await requireStudyPolicyCommunity(input)
  return readCommunityStudyPolicy(input)
}

export async function updateCommunityStudyPolicy(input: {
  env: Env
  communityRepository: CommunityStudyPolicyRepository
  communityId: string
  userId?: string
  actor?: CommunityMutationActor
  body: CommunityStudyPolicyPatch | null
}): Promise<CommunityStudyPolicy> {
  const body = assertCommunityStudyPolicyPatch(input.body)
  const actor = input.actor ?? communityMutationActorFromUserId(input.userId ?? "")
  const community = await requireStudyPolicyCommunity({
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    actor,
  })

  const now = nowIso()
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await ensureCommunityStudyPolicyRow({
      client: db.client,
      community,
      now,
    })
    await ensureCommunityStudyPolicyColumn(db.client)
    await db.client.execute({
      sql: `
        UPDATE communities
        SET study_enabled = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        body.study_enabled ? 1 : 0,
        now,
      ],
    })
  } finally {
    db.close()
  }

  await writeAuditEventForEnv(input.env, {
    action: "community.study_policy_updated",
    actorId: "adminOverride" in actor ? actor.adminOverride.adminActorId : actor.userId,
    actorType: "adminOverride" in actor ? "operator" : "user",
    communityId: input.communityId,
    createdAt: now,
    targetId: input.communityId,
    targetType: "community",
    metadata: {
      owner_user_id: community.creator_user_id,
      study_enabled: body.study_enabled,
      ...("adminOverride" in actor
        ? {
            acting_user_id: actor.userId,
            scope: actor.adminOverride.scope,
          }
        : {}),
    },
  })

  return readCommunityStudyPolicy(input)
}
