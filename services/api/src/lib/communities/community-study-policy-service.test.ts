import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { describe, expect, test } from "bun:test"
import {
  getCommunityStudyPolicy,
  updateStudyPolicyRow,
  updateCommunityStudyPolicy,
} from "./community-study-policy-service"
import type { CommunityDatabaseBindingRow, CommunityRow } from "../auth/auth-db-rows"
import type { Client } from "../sql-client"
import type { Env } from "../../env"

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "study-policy-"))
  const communityDbPath = join(dir, "community.db")
  const controlDbPath = join(dir, "control.db")
  const communityId = "cmt_study_policy"
  const now = "2026-06-29T00:00:00.000Z"
  const community: CommunityRow = {
    avatar_ref: null,
    banner_ref: null,
    community_id: communityId,
    created_at: now,
    creator_user_id: "usr_owner",
    description: "A community without a local row yet",
    display_name: "Study Test",
    follower_count: 0,
    namespace_verification_id: null,
    pending_namespace_verification_session_id: null,
    primary_database_binding_id: "cdb_study_policy",
    provisioning_state: "active",
    route_slug: null,
    status: "active",
    transfer_state: "none",
    updated_at: now,
  }
  const binding: CommunityDatabaseBindingRow = {
    binding_role: "primary",
    community_database_binding_id: "cdb_study_policy",
    community_id: communityId,
    created_at: now,
    database_id: null,
    database_name: "community",
    database_url: `file:${communityDbPath}`,
    group_id: null,
    group_name: "test",
    location: null,
    organization_slug: "pirate-test",
    requires_credentials: false,
    status: "active",
    transferred_at: null,
    updated_at: now,
  }
  const repo = {
    getCommunityById: async (id: string) => id === communityId ? community : null,
    getCommunityByNamespaceVerificationId: async () => null,
    getCommunityByRouteSlug: async () => null,
    getPrimaryCommunityDatabaseBinding: async (id: string) => id === communityId ? binding : null,
    listActiveCommunities: async () => [],
    searchActiveCommunities: async () => [],
  }
  const control = createClient({ url: `file:${controlDbPath}` })
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
      CONTROL_PLANE_DATABASE_URL: `file:${controlDbPath}`,
    } as Env,
    repo,
  }
}

const adminActor = {
  adminOverride: { adminActorId: "adm_test", scope: "test" },
  authType: "admin",
  userId: "usr_owner",
} as const

describe("community study policy", () => {
  test("defaults to disabled when the local community row is missing", async () => {
    const ctx = await setup()

    const policy = await getCommunityStudyPolicy({
      actor: adminActor,
      communityId: ctx.communityId,
      communityRepository: ctx.repo,
      env: ctx.env,
})

    expect(policy).toEqual({
      community_id: ctx.communityId,
      study_enabled: false,
      updated_at: null,
    })
  })

  test("creates a missing local community row before updating study policy", async () => {
    const ctx = await setup()

    const policy = await updateCommunityStudyPolicy({
      actor: adminActor,
      body: { study_enabled: true },
      communityId: ctx.communityId,
      communityRepository: ctx.repo,
      env: ctx.env,
    })

    expect(policy.study_enabled).toBe(true)

    const community = createClient({ url: `file:${ctx.communityDbPath}` })
    const result = await community.execute({
      sql: "SELECT community_id, display_name, study_enabled FROM communities WHERE community_id = ?1",
      args: [ctx.communityId],
    })
    community.close()

    expect(result.rows).toEqual([
      {
        community_id: ctx.communityId,
        display_name: "Study Test",
        study_enabled: 1,
      },
    ])
  })

  test("updates study policy without schema widening when study_enabled already exists", async () => {
    const statements: string[] = []
    const client = {
      async execute(statement: string | { sql: string }) {
        const sql = typeof statement === "string" ? statement : statement.sql
        statements.push(sql)
        if (/ALTER\s+TABLE/iu.test(sql)) {
          throw new Error("Statement rejected by shard write guard: ALTER")
        }
        return { rows: [], rowsAffected: 1 }
      },
    } as unknown as Client

    await updateStudyPolicyRow({
      client,
      communityId: "cmt_policy_d1",
      studyEnabled: true,
      updatedAt: "2026-06-30T00:00:00.000Z",
    })

    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain("UPDATE communities")
    expect(statements[0]).toContain("study_enabled")
  })
})
