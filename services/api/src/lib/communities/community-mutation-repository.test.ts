import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient, type Client } from "@libsql/client"
import { describe, expect, test } from "bun:test"
import { setCommunityLifecycleStatus } from "./community-mutation-repository"
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
      primary_database_binding_id TEXT,
      follower_count INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  return client
}

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
        pending_namespace_verification_session_id, primary_database_binding_id, follower_count,
        created_at, updated_at
      ) VALUES (?1, 'usr_owner', ?1, NULL, NULL, NULL, ?2, ?3, 'none', NULL, NULL, NULL, NULL, 0,
        '2026-06-22T00:00:00.000Z', '2026-06-22T00:00:00.000Z')
    `,
    args: [communityId, status, provisioningState],
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
})
