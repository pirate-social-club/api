import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ANY_COMMUNITY_ROLE,
  OWNER_OR_ADMIN_ROLE,
  canAccessCommunity,
  getCommunityMembershipState,
  hasCommunityRole,
} from "../src/lib/communities/membership/membership-state-store"

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createTestClient(): Promise<Client> {
  const dir = await mkdtemp(join(tmpdir(), "pirate-membership-state-"))
  cleanupPaths.push(dir)
  const client = createClient({ url: `file:${join(dir, "community.db")}` })
  await client.execute(`
    CREATE TABLE community_memberships (
      membership_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE community_roles (
      role_assignment_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  return client
}

async function insertRole(client: Client, input: {
  userId: string
  role: "owner" | "admin" | "moderator"
  status?: "active" | "revoked"
  createdAt?: string
}): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO community_roles (
        role_assignment_id, community_id, user_id, role, status, created_at
      ) VALUES (
        ?1, 'cmt_roles', ?2, ?3, ?4, ?5
      )
    `,
    args: [
      `rol_${input.userId}_${input.role}_${input.status ?? "active"}`,
      input.userId,
      input.role,
      input.status ?? "active",
      input.createdAt ?? "2026-05-05T00:00:00.000Z",
    ],
  })
}

describe("membership state role resolution", () => {
  test("returns the highest active role when a user has multiple roles", async () => {
    const client = await createTestClient()
    try {
      await insertRole(client, { userId: "usr_multi", role: "moderator" })
      await insertRole(client, { userId: "usr_multi", role: "admin" })

      const state = await getCommunityMembershipState(client, "cmt_roles", "usr_multi")

      expect(state.role).toBe("admin")
      expect(state.role_status).toBe("active")
      expect(hasCommunityRole(state, OWNER_OR_ADMIN_ROLE)).toBe(true)
      expect(canAccessCommunity(state)).toBe(true)
    } finally {
      client.close()
    }
  })

  test("does not grant access for revoked roles", async () => {
    const client = await createTestClient()
    try {
      await insertRole(client, { userId: "usr_revoked", role: "owner", status: "revoked" })

      const state = await getCommunityMembershipState(client, "cmt_roles", "usr_revoked")

      expect(state.role).toBeNull()
      expect(state.role_status).toBe("revoked")
      expect(hasCommunityRole(state, ANY_COMMUNITY_ROLE)).toBe(false)
      expect(canAccessCommunity(state)).toBe(false)
    } finally {
      client.close()
    }
  })
})
