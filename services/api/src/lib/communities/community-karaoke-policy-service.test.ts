import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import type { ShardQueryResult, ShardResult, ShardRpc, ShardSqlStatement } from "@pirate/api-shared"
import { describe, expect, test } from "bun:test"
import {
  getCommunityKaraokePolicy,
  updateCommunityKaraokePolicy,
} from "./community-karaoke-policy-service"
import type { CommunityDatabaseBindingRow, CommunityRow } from "../auth/auth-db-rows"
import type { Env } from "../../env"

function normalizeShardStatement(statement: ShardSqlStatement | string): { sql: string; args?: unknown[] } {
  return typeof statement === "string" ? { sql: statement } : { sql: statement.sql, args: statement.args }
}

function makeLocalCommunityShard(databaseUrl: string): ShardRpc {
  return {
    async execute(input: { statement: ShardSqlStatement | string }): Promise<ShardResult<ShardQueryResult>> {
      const client = createClient({ url: databaseUrl })
      try {
        const statement = normalizeShardStatement(input.statement)
        return { ok: true, value: await client.execute({ sql: statement.sql, args: (statement.args ?? []) as never[] }) }
      } finally {
        client.close()
      }
    },
    async batch(input: { statements: Array<ShardSqlStatement | string> }): Promise<ShardResult<ShardQueryResult[]>> {
      const client = createClient({ url: databaseUrl })
      try {
        const results: ShardQueryResult[] = []
        for (const raw of input.statements) {
          const statement = normalizeShardStatement(raw)
          results.push(await client.execute({ sql: statement.sql, args: (statement.args ?? []) as never[] }))
        }
        return { ok: true, value: results }
      } finally {
        client.close()
      }
    },
    async batchWrite(input: { statements: ShardSqlStatement[] }): Promise<ShardResult<ShardQueryResult[]>> {
      const client = createClient({ url: databaseUrl })
      try {
        const results: ShardQueryResult[] = []
        for (const statement of input.statements) {
          results.push(await client.execute({ sql: statement.sql, args: (statement.args ?? []) as never[] }))
        }
        return { ok: true, value: results }
      } finally {
        client.close()
      }
    },
  } as ShardRpc
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "karaoke-policy-"))
  const communityDbPath = join(dir, "community.db")
  const controlDbPath = join(dir, "control.db")
  const communityId = "cmt_karaoke_policy"
  const now = "2026-06-18T00:00:00.000Z"
  const community: CommunityRow = {
    community_id: communityId,
    creator_user_id: "usr_owner",
    display_name: "Karaoke Test",
    description: "A community without a local row yet",
    avatar_ref: null,
    banner_ref: null,
    status: "active",
    provisioning_state: "active",
    transfer_state: "none",
    route_slug: null,
    namespace_verification_id: null,
    pending_namespace_verification_session_id: null,
    primary_database_binding_id: "cdb_karaoke_policy",
    follower_count: 0,
    created_at: now,
    updated_at: now,
  }
  const binding: CommunityDatabaseBindingRow = {
    community_database_binding_id: "cdb_karaoke_policy",
    community_id: communityId,
    binding_role: "primary",
    organization_slug: "pirate-test",
    group_name: "test",
    group_id: null,
    database_name: "community",
    database_id: null,
    database_url: `file:${communityDbPath}`,
    location: null,
    requires_credentials: false,
    status: "active",
    transferred_at: null,
    created_at: now,
    updated_at: now,
  }
  const repo = {
    getCommunityById: async (id: string) => id === communityId ? community : null,
    getPrimaryCommunityDatabaseBinding: async (id: string) => id === communityId ? binding : null,
    getCommunityByRouteSlug: async () => null,
    getCommunityByNamespaceVerificationId: async () => null,
    listActiveCommunities: async () => [],
    searchActiveCommunities: async () => [],
  }
  const communityDb = createClient({ url: `file:${communityDbPath}` })
  await communityDb.execute(`
    CREATE TABLE communities (
      community_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      artist_identity_id TEXT,
      artist_governance_state TEXT NOT NULL,
      membership_mode TEXT NOT NULL,
      default_age_gate_policy TEXT NOT NULL,
      allow_anonymous_identity INTEGER NOT NULL DEFAULT 0,
      anonymous_identity_scope TEXT,
      donation_partner_id TEXT,
      donation_policy_mode TEXT NOT NULL,
      donation_partner_status TEXT NOT NULL,
      governance_mode TEXT NOT NULL,
      settings_json TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  communityDb.close()
  const control = createClient({ url: `file:${controlDbPath}` })
  await control.execute(`
    CREATE TABLE community_database_routing (
      community_id TEXT PRIMARY KEY,
      backend TEXT NOT NULL,
      provisioning_state TEXT NOT NULL,
      shard_worker_id TEXT,
      binding_name TEXT,
      region TEXT,
      turso_database_binding_id TEXT,
      migrated_at TEXT,
      decommissioned_at TEXT,
      last_error_at TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await control.execute({
    sql: `
      INSERT INTO community_database_routing (
        community_id, backend, provisioning_state, shard_worker_id, binding_name,
        region, turso_database_binding_id, migrated_at, decommissioned_at,
        last_error_at, last_error_message, created_at, updated_at
      )
      VALUES (?1, 'd1', 'ready', 'test-shard', 'DB_CMTY_KARAOKE_POLICY', 'test',
              NULL, ?2, NULL, NULL, NULL, ?2, ?2)
    `,
    args: [communityId, now],
  })
  await control.execute(`
    CREATE TABLE audit_log (
      audit_event_id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      community_id TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  control.close()

  return {
    communityDbPath,
    communityId,
    env: {
      ENVIRONMENT: "test",
      COMMUNITY_D1_SHARD: makeLocalCommunityShard(`file:${communityDbPath}`) as never,
      CONTROL_PLANE_DATABASE_URL: `file:${controlDbPath}`,
    } as Env,
    repo,
  }
}

describe("community karaoke policy", () => {
  test("defaults to disabled when the local community row is missing", async () => {
    const ctx = await setup()

    const policy = await getCommunityKaraokePolicy({
      actor: {
        authType: "admin",
        userId: "usr_owner",
        adminOverride: { adminActorId: "adm_test", scope: "test" },
      },
      communityId: ctx.communityId,
      communityRepository: ctx.repo,
      env: ctx.env,
    })

    expect(policy).toMatchObject({
      community_id: ctx.communityId,
      karaoke_enabled: false,
      karaoke_scoring_enabled: false,
      karaoke_stt_provider: "assistant",
      karaoke_voice_coach_enabled: false,
    })
  })

  test("creates a missing local community row before updating karaoke policy", async () => {
    const ctx = await setup()

    const policy = await updateCommunityKaraokePolicy({
      actor: {
        authType: "admin",
        userId: "usr_owner",
        adminOverride: { adminActorId: "adm_test", scope: "test" },
      },
      body: { karaoke_enabled: true },
      communityId: ctx.communityId,
      communityRepository: ctx.repo,
      env: ctx.env,
    })

    expect(policy.karaoke_enabled).toBe(true)

    const community = createClient({ url: `file:${ctx.communityDbPath}` })
    const result = await community.execute({
      sql: "SELECT community_id, display_name, karaoke_enabled FROM communities WHERE community_id = ?1",
      args: [ctx.communityId],
    })
    community.close()

    expect(result.rows).toEqual([
      {
        community_id: ctx.communityId,
        display_name: "Karaoke Test",
        karaoke_enabled: 1,
      },
    ])
  })
})
