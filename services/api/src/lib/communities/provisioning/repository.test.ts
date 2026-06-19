import { afterEach, beforeEach, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { persistProvisionedD1Binding } from "./repository"

let cp: Client

beforeEach(async () => {
  cp = createClient({ url: ":memory:" })
  await cp.execute(`
    CREATE TABLE community_database_bindings (
      community_database_binding_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      binding_role TEXT NOT NULL,
      organization_slug TEXT NOT NULL,
      group_name TEXT NOT NULL,
      group_id TEXT,
      database_name TEXT NOT NULL,
      database_id TEXT,
      database_url TEXT NOT NULL,
      location TEXT,
      requires_credentials INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      transferred_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  // The real uniqueness constraint the function is designed around.
  await cp.execute(`
    CREATE UNIQUE INDEX idx_community_bindings_active_target
      ON community_database_bindings(organization_slug, group_name, database_name)
      WHERE status IN ('active', 'pending_transfer')
  `)
})

afterEach(() => {
  cp.close()
})

async function seedPendingBinding(bindingId: string, communityId: string): Promise<void> {
  await cp.execute({
    sql: `
      INSERT INTO community_database_bindings (
        community_database_binding_id, community_id, binding_role, organization_slug, group_name,
        group_id, database_name, database_id, database_url, location, requires_credentials, status,
        created_at, updated_at
      ) VALUES (?1, ?2, 'primary', 'shard', 'shard', NULL, ?3, NULL, ?4, NULL, 0, 'active', ?5, ?5)
    `,
    args: [bindingId, communityId, `pending-${communityId}`, `d1://pending-${communityId}.invalid`, "t0"],
  })
}

test("replaces the pending sentinel URL with the resolved shard binding and clears credentials", async () => {
  await seedPendingBinding("cdb_1", "cmt_d1")

  await persistProvisionedD1Binding(cp, {
    communityDatabaseBindingId: "cdb_1",
    bindingName: "DB_CMTY_0001",
    databaseUrl: "d1://shard/DB_CMTY_0001",
    region: "weur",
    updatedAt: "2026-06-19T00:00:00Z",
  })

  const row = (await cp.execute({
    sql: "SELECT * FROM community_database_bindings WHERE community_database_binding_id = ?1",
    args: ["cdb_1"],
  })).rows[0]

  expect(row.database_url).toBe("d1://shard/DB_CMTY_0001")
  expect(row.database_name).toBe("DB_CMTY_0001")
  expect(row.organization_slug).toBe("shard")
  expect(row.location).toBe("weur")
  expect(Number(row.requires_credentials)).toBe(0)
  expect(row.status).toBe("active")
  expect(row.updated_at).toBe("2026-06-19T00:00:00Z")
})

test("two D1 communities stay active concurrently — distinct binding names satisfy the unique target index", async () => {
  await seedPendingBinding("cdb_1", "cmt_a")
  await seedPendingBinding("cdb_2", "cmt_b")

  await persistProvisionedD1Binding(cp, {
    communityDatabaseBindingId: "cdb_1",
    bindingName: "DB_CMTY_0001",
    databaseUrl: "d1://shard/DB_CMTY_0001",
    region: "weur",
    updatedAt: "t1",
  })
  // Distinct binding name → no collision on (shard, shard, database_name) even
  // though both are active under the same org/group. This is the 1:1 model.
  await persistProvisionedD1Binding(cp, {
    communityDatabaseBindingId: "cdb_2",
    bindingName: "DB_CMTY_0002",
    databaseUrl: "d1://shard/DB_CMTY_0002",
    region: "weur",
    updatedAt: "t1",
  })

  const count = (await cp.execute(
    "SELECT COUNT(*) AS n FROM community_database_bindings WHERE status = 'active'",
  )).rows[0]
  expect(Number(count.n)).toBe(2)
})
