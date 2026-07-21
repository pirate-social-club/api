import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient, type Client } from "@libsql/client"
import { describe, expect, test } from "bun:test"
import { attachNamespaceToCommunity, setCommunityLifecycleStatus } from "./community-mutation-repository"
import { listActiveCommunityRows, searchActiveCommunityRows } from "../auth/auth-db-community-queries"

async function setupControl(): Promise<Client> {
  const dir = await mkdtemp(join(tmpdir(), "community-lifecycle-"))
  const client = createClient({ url: `file:${join(dir, "control.db")}` })
  await client.execute(`
    CREATE TABLE communities (
      community_id TEXT PRIMARY KEY,
      creator_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      avatar_ref TEXT,
      banner_ref TEXT,
      status TEXT NOT NULL,
      provisioning_state TEXT NOT NULL,
      transfer_state TEXT NOT NULL,
      route_slug TEXT,
      namespace_verification_id TEXT,
      pending_namespace_verification_session_id TEXT,
      follower_count INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE community_database_routing (
      community_id TEXT PRIMARY KEY,
      provisioning_state TEXT NOT NULL,
      shard_worker_id TEXT,
      binding_name TEXT,
      region TEXT,
      decommissioned_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE community_namespace_bindings (
      community_namespace_binding_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      namespace_verification_id TEXT NOT NULL,
      namespace_role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  return client
}

describe("attachNamespaceToCommunity", () => {
  test("atomically replaces a same-root primary verification during recovery", async () => {
    const client = await setupControl()
    await insertCommunity(client, "cmt_recovery", "active")
    await client.execute(`
      UPDATE communities
      SET namespace_verification_id = 'nv_old', route_slug = 'dankmeme'
      WHERE community_id = 'cmt_recovery'
    `)
    await client.execute(`
      INSERT INTO community_namespace_bindings (
        community_namespace_binding_id, community_id, namespace_verification_id,
        namespace_role, status, created_at, updated_at
      ) VALUES ('cnb_old', 'cmt_recovery', 'nv_old', 'primary', 'active',
        '2026-06-22T00:00:00.000Z', '2026-06-22T00:00:00.000Z')
    `)

    const updated = await attachNamespaceToCommunity(client, {
      communityNamespaceBindingId: "cnb_new",
      communityId: "cmt_recovery",
      namespaceVerificationId: "nv_new",
      namespaceRole: "primary",
      replacesNamespaceVerificationId: "nv_old",
      routeSlug: "dankmeme",
      updatedAt: "2026-06-22T01:00:00.000Z",
    })

    expect(updated.namespace_verification_id).toBe("nv_new")
    const bindings = await client.execute({
      sql: `SELECT namespace_verification_id, status FROM community_namespace_bindings ORDER BY created_at, namespace_verification_id`,
      args: [],
    })
    expect(bindings.rows).toEqual([
      expect.objectContaining({ namespace_verification_id: "nv_old", status: "superseded" }),
      expect.objectContaining({ namespace_verification_id: "nv_new", status: "active" }),
    ])
    client.close()
  })

  test("refuses recovery when the primary changed concurrently", async () => {
    const client = await setupControl()
    await insertCommunity(client, "cmt_race", "active")
    await client.execute(`
      UPDATE communities SET namespace_verification_id = 'nv_other' WHERE community_id = 'cmt_race'
    `)

    await expect(attachNamespaceToCommunity(client, {
      communityNamespaceBindingId: "cnb_new",
      communityId: "cmt_race",
      namespaceVerificationId: "nv_new",
      namespaceRole: "primary",
      replacesNamespaceVerificationId: "nv_old",
      routeSlug: "dankmeme",
      updatedAt: "2026-06-22T01:00:00.000Z",
    })).rejects.toThrow("changed before recovery completed")
    client.close()
  })
})

async function insertCommunity(
  client: Client,
  communityId: string,
  status: string,
  provisioningState = "active",
): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO communities (
        community_id, creator_user_id, display_name, description, avatar_ref, banner_ref,
        status, provisioning_state, transfer_state, route_slug, namespace_verification_id,
        pending_namespace_verification_session_id, follower_count,
        created_at, updated_at
      ) VALUES (?1, 'usr_owner', ?1, NULL, NULL, NULL, ?2, ?3, 'none', NULL, NULL, NULL, 0,
        '2026-06-22T00:00:00.000Z', '2026-06-22T00:00:00.000Z')
    `,
    args: [communityId, status, provisioningState],
  })
}

async function insertRouting(
  client: Client,
  communityId: string,
  provisioningState: string,
  decommissionedAt: string | null = null,
): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO community_database_routing (
        community_id, provisioning_state, shard_worker_id, binding_name, region,
        decommissioned_at, created_at, updated_at
      ) VALUES (?1, ?2, 'community-d1-shard-staging', 'DB_CMTY_0001', 'wnam',
        ?3, '2026-06-22T00:00:00.000Z', '2026-06-22T00:00:00.000Z')
    `,
    args: [communityId, provisioningState, decommissionedAt],
  })
}

describe("setCommunityLifecycleStatus", () => {
  test("archives an active community", async () => {
    const client = await setupControl()
    await insertCommunity(client, "cmt_a", "active")

    const updated = await setCommunityLifecycleStatus(client, {
      communityId: "cmt_a",
      targetStatus: "archived",
      allowedFromStatuses: ["active", "archived"],
      updatedAt: "2026-06-22T01:00:00.000Z",
    })

    expect(updated.status).toBe("archived")
    expect(updated.updated_at).toBe("2026-06-22T01:00:00.000Z")
    client.close()
  })

  test("is idempotent when already at target status", async () => {
    const client = await setupControl()
    await insertCommunity(client, "cmt_b", "archived")

    const updated = await setCommunityLifecycleStatus(client, {
      communityId: "cmt_b",
      targetStatus: "archived",
      allowedFromStatuses: ["active", "archived"],
      updatedAt: "2026-06-22T02:00:00.000Z",
    })

    expect(updated.status).toBe("archived")
    // no-op: original updated_at preserved
    expect(updated.updated_at).toBe("2026-06-22T00:00:00.000Z")
    client.close()
  })

  test("rejects a transition from a disallowed status", async () => {
    const client = await setupControl()
    await insertCommunity(client, "cmt_c", "frozen")

    await expect(
      setCommunityLifecycleStatus(client, {
        communityId: "cmt_c",
        targetStatus: "active",
        allowedFromStatuses: ["archived", "active"],
        updatedAt: "2026-06-22T03:00:00.000Z",
      }),
    ).rejects.toThrow()

    // status unchanged after a rejected transition
    const row = await client.execute({ sql: "SELECT status FROM communities WHERE community_id = ?1", args: ["cmt_c"] })
    expect(row.rows[0]?.status).toBe("frozen")
    client.close()
  })

  test("throws when the community is missing", async () => {
    const client = await setupControl()
    await expect(
      setCommunityLifecycleStatus(client, {
        communityId: "cmt_missing",
        targetStatus: "archived",
        allowedFromStatuses: ["active", "archived"],
        updatedAt: "2026-06-22T04:00:00.000Z",
      }),
    ).rejects.toThrow()
    client.close()
  })

  test("archived communities disappear from active discovery", async () => {
    const client = await setupControl()
    await insertCommunity(client, "cmt_live", "active")
    await insertCommunity(client, "cmt_dead", "active")
    await setCommunityLifecycleStatus(client, {
      communityId: "cmt_dead",
      targetStatus: "archived",
      allowedFromStatuses: ["active", "archived"],
      updatedAt: "2026-06-22T05:00:00.000Z",
    })

    const listed = await listActiveCommunityRows(client)
    expect(listed.map((c) => c.community_id)).toEqual(["cmt_live"])

    const searched = await searchActiveCommunityRows(client, { query: "cmt", limit: 10 })
    expect(searched.map((c) => c.community_id)).toEqual(["cmt_live"])
    client.close()
  })

  test("ready-routed active discovery excludes communities without usable routing", async () => {
    const client = await setupControl()
    await insertCommunity(client, "cmt_ready", "active")
    await insertCommunity(client, "cmt_no_route", "active")
    await insertCommunity(client, "cmt_pending_route", "active")
    await insertCommunity(client, "cmt_decommissioned_route", "active")
    await insertRouting(client, "cmt_ready", "ready")
    await insertRouting(client, "cmt_pending_route", "provisioning")
    await insertRouting(client, "cmt_decommissioned_route", "ready", "2026-06-23T00:00:00.000Z")

    const listed = await listActiveCommunityRows(client)
    expect(listed.map((c) => c.community_id)).toEqual([
      "cmt_decommissioned_route",
      "cmt_no_route",
      "cmt_pending_route",
      "cmt_ready",
    ])

    const readyRouted = await listActiveCommunityRows(client, { requireReadyRouting: true })
    expect(readyRouted.map((c) => c.community_id)).toEqual(["cmt_ready"])
    client.close()
  })
})
