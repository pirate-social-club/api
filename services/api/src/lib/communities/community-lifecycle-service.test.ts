import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { describe, expect, test } from "bun:test"
import { archiveCommunity, unarchiveCommunity } from "./community-lifecycle-service"
import type { CommunityRow } from "../auth/auth-db-rows"
import type { Env } from "../../env"

const COMMUNITY_ID = "cmt_lifecycle"
const OWNER_ID = "usr_owner"

function makeCommunity(overrides: Partial<CommunityRow> = {}): CommunityRow {
  return {
    community_id: COMMUNITY_ID,
    creator_user_id: OWNER_ID,
    display_name: "Lifecycle Test",
    description: null,
    avatar_ref: null,
    banner_ref: null,
    status: "active",
    provisioning_state: "active",
    transfer_state: "none",
    route_slug: null,
    namespace_verification_id: null,
    pending_namespace_verification_session_id: null,
    follower_count: 0,
    created_at: "2026-06-22T00:00:00.000Z",
    updated_at: "2026-06-22T00:00:00.000Z",
    ...overrides,
  }
}

async function setup(community: CommunityRow) {
  const dir = await mkdtemp(join(tmpdir(), "lifecycle-svc-"))
  const controlDbPath = join(dir, "control.db")
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

  const calls: Array<{ targetStatus: string; allowedFromStatuses: readonly string[] }> = []
  const repo = {
    getCommunityById: async (id: string) => (id === COMMUNITY_ID ? community : null),
    setCommunityLifecycleStatus: async (input: {
      communityId: string
      targetStatus: CommunityRow["status"]
      allowedFromStatuses: readonly CommunityRow["status"][]
      updatedAt: string
    }) => {
      calls.push({ targetStatus: input.targetStatus, allowedFromStatuses: input.allowedFromStatuses })
      return makeCommunity({ status: input.targetStatus, updated_at: input.updatedAt })
    },
  }

  return {
    repo,
    calls,
    controlDbPath,
    env: { CONTROL_PLANE_DATABASE_URL: `file:${controlDbPath}` } as Env,
  }
}

const ownerActor = { userId: OWNER_ID, authType: "user" as const }
const strangerActor = { userId: "usr_stranger", authType: "user" as const }

describe("community lifecycle service", () => {
  test("owner can archive an active community", async () => {
    const ctx = await setup(makeCommunity({ status: "active" }))

    const result = await archiveCommunity({
      env: ctx.env,
      communityRepository: ctx.repo,
      communityId: COMMUNITY_ID,
      actor: ownerActor,
    })

    expect(result).toEqual({ community_id: COMMUNITY_ID, status: "archived" })
    expect(ctx.calls).toEqual([{ targetStatus: "archived", allowedFromStatuses: ["active", "archived"] }])
  })

  test("non-owner cannot archive", async () => {
    const ctx = await setup(makeCommunity({ status: "active" }))

    await expect(
      archiveCommunity({
        env: ctx.env,
        communityRepository: ctx.repo,
        communityId: COMMUNITY_ID,
        actor: strangerActor,
      }),
    ).rejects.toThrow()
    expect(ctx.calls).toEqual([])
  })

  test("owner can unarchive an archived community", async () => {
    const ctx = await setup(makeCommunity({ status: "archived" }))

    const result = await unarchiveCommunity({
      env: ctx.env,
      communityRepository: ctx.repo,
      communityId: COMMUNITY_ID,
      actor: ownerActor,
    })

    expect(result).toEqual({ community_id: COMMUNITY_ID, status: "active" })
    expect(ctx.calls).toEqual([{ targetStatus: "active", allowedFromStatuses: ["archived", "active"] }])
  })

  test("admin override can archive and is audited as the operator", async () => {
    const ctx = await setup(makeCommunity({ status: "active" }))
    const adminActor = {
      userId: "usr_impersonated",
      authType: "admin" as const,
      adminOverride: { adminActorId: "adm_op", scope: "support" },
    }

    const result = await archiveCommunity({
      env: ctx.env,
      communityRepository: ctx.repo,
      communityId: COMMUNITY_ID,
      actor: adminActor,
    })

    expect(result).toEqual({ community_id: COMMUNITY_ID, status: "archived" })
    expect(ctx.calls).toEqual([{ targetStatus: "archived", allowedFromStatuses: ["active", "archived"] }])

    const control = createClient({ url: `file:${ctx.controlDbPath}` })
    const rows = await control.execute({
      sql: "SELECT actor_type, actor_id, metadata_json FROM audit_log WHERE action = 'community.archive' ORDER BY created_at",
      args: [],
    })
    control.close()

    // requireAdminOverrideOrOwnedCommunity writes a grant event AND the service writes the action event;
    // both must attribute the real operator, never the impersonated user.
    expect(rows.rows.length).toBeGreaterThanOrEqual(1)
    for (const row of rows.rows) {
      expect(row.actor_type).toBe("operator")
      expect(row.actor_id).toBe("adm_op")
    }
    // The action event is the one carrying the resulting lifecycle status in its metadata.
    const actionEvent = rows.rows.find((row) => {
      const meta = JSON.parse(String(row.metadata_json))
      return typeof meta.status === "string"
    })
    expect(actionEvent).toBeDefined()
    expect(JSON.parse(String(actionEvent?.metadata_json))).toMatchObject({
      status: "archived",
      acting_user_id: "usr_impersonated",
      scope: "support",
      owner_user_id: OWNER_ID,
    })
  })

  test("unarchive is owner-gated even while archived (status-blind ownership)", async () => {
    const ctx = await setup(makeCommunity({ status: "archived" }))

    await expect(
      unarchiveCommunity({
        env: ctx.env,
        communityRepository: ctx.repo,
        communityId: COMMUNITY_ID,
        actor: strangerActor,
      }),
    ).rejects.toThrow()
    expect(ctx.calls).toEqual([])
  })
})
