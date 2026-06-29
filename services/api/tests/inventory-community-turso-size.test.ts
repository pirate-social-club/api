import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createClient } from "@libsql/client"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveCoreRepoPath } from "../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import {
  INVENTORY_HOLDOUT_BYTES,
  INVENTORY_TABLES,
  discoverFixtureBindings,
  measureCommunities,
  measureCommunityDatabase,
  summarize,
  type CommunityInventory,
} from "../scripts/inventory-community-turso-size"

const cleanupPaths: string[] = []

setDefaultTimeout(20_000)

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

async function tmpCommunityDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "inventory-fixture-"))
  cleanupPaths.push(dir)
  return dir
}

async function applyCommunityMigrations(databasePath: string, maxMigration: number): Promise<void> {
  const client = createClient({ url: `file:${databasePath}` })
  try {
    await client.execute("PRAGMA foreign_keys = OFF")
    await client.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name TEXT PRIMARY KEY,
        migration_label TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    const migrationsDir = await resolveCoreRepoPath("db/community-template/migrations", {
      serviceRoot: fileURLToPath(new URL("..", import.meta.url)),
    })
    const entries = (await readdir(migrationsDir))
      .filter((entry) => entry.endsWith(".sql"))
      .sort()
      .filter((entry) => Number.parseInt(entry.slice(0, 4), 10) <= maxMigration)

    for (const entry of entries) {
      const sql = await readFile(join(migrationsDir, entry), "utf8")
      for (const statement of splitSqlStatements(sql)) {
        for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
          if (sqliteStatement.trim().toUpperCase().startsWith("PRAGMA FOREIGN_KEYS")) continue
          await client.execute(sqliteStatement)
        }
      }
      await client.execute({
        sql: `
          INSERT INTO schema_migrations (migration_name, migration_label, checksum)
          VALUES (?1, 'community-template', ?2)
        `,
        args: [entry, createHash("sha256").update(sql).digest("hex")],
      })
    }
  } finally {
    client.close()
  }
}

type SeedCounts = {
  communities: number
  memberships: number
  translations: number
  assistantChats: number
  jobs: number
}

async function seedSimpleCommunity(databasePath: string, counts: SeedCounts): Promise<void> {
  const client = createClient({ url: `file:${databasePath}` })
  try {
    await client.execute("PRAGMA foreign_keys = OFF")
    const now = "2026-01-01T00:00:00Z"
    const communityId = "com_test_inventory"

    if (counts.communities > 0) {
      await client.execute({
        sql: `INSERT INTO communities (community_id, display_name, status, artist_governance_state, membership_mode, default_age_gate_policy, donation_policy_mode, donation_partner_status, governance_mode, created_by_user_id, created_at, updated_at) VALUES (?1, ?2, 'active', 'fan_run', 'open', 'none', 'none', 'unconfigured', 'centralized', 'usr_owner', ?3, ?3)`,
        args: [communityId, "Inventory Test", now],
      })
    }

    for (let i = 0; i < counts.memberships; i += 1) {
      await client.execute({
        sql: `INSERT INTO community_memberships (membership_id, community_id, user_id, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'member', ?4, ?4)`,
        args: [`mem_${i}`, communityId, `usr_${i}`, now],
      })
    }

    for (let i = 0; i < counts.translations; i += 1) {
      await client.execute({
        sql: `INSERT INTO content_translations (content_translation_id, content_type, content_id, locale, source_hash, outcome, created_at, updated_at) VALUES (?1, 'post', ?2, 'es', ?3, 'translated', ?4, ?4)`,
        args: [`tr_${i}`, `post_${i}`, `hash_${i}`, now],
      })
    }

    for (let i = 0; i < counts.assistantChats; i += 1) {
      await client.execute({
        sql: `INSERT INTO community_assistant_chats (chat_id, community_id, user_id, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
        args: [`chat_${i}`, communityId, "usr_owner", now],
      })
    }

    for (let i = 0; i < counts.jobs; i += 1) {
      await client.execute({
        sql: `INSERT INTO community_jobs (job_id, community_id, job_type, subject_type, subject_id, status, created_at, updated_at) VALUES (?1, ?2, 'test', 'community', ?3, 'queued', ?4, ?4)`,
        args: [`job_${i}`, communityId, communityId, now],
      })
    }
  } finally {
    client.close()
  }
}

function openFileClient(databasePath: string) {
  return () => createClient({ url: `file:${databasePath}` })
}

describe("measureCommunityDatabase", () => {
  let workDir: string
  let databasePath: string

  beforeEach(async () => {
    workDir = await tmpCommunityDir()
    databasePath = join(workDir, "com_test_one.db")
    await applyCommunityMigrations(databasePath, 1098)
    await seedSimpleCommunity(databasePath, {
      communities: 1,
      memberships: 3,
      translations: 2,
      assistantChats: 4,
      jobs: 5,
    })
  })

  test("reports page_count, page_size, totalBytes, and table row counts", async () => {
    const inv = await measureCommunityDatabase({
      communityId: "com_test_one",
      source: "fixture-dir",
      databaseUrl: `file:${databasePath}`,
      openClient: openFileClient(databasePath),
    })

    expect(inv.error).toBeNull()
    expect(inv.pageCount).not.toBeNull()
    expect(inv.pageSize).not.toBeNull()
    expect(inv.totalBytes).not.toBeNull()
    expect(inv.totalBytes!).toBeGreaterThan(0)
    expect(inv.totalBytes!).toBe(inv.pageCount! * inv.pageSize!)
    expect(inv.holdout).toBe(false)

    const byName = new Map(inv.tables.map((t) => [t.name, t]))
    for (const name of INVENTORY_TABLES) {
      expect(byName.has(name)).toBe(true)
      const table = byName.get(name)!
      expect(table.present).toBe(true)
    }
    expect(byName.get("communities")!.rowCount).toBe(1)
    expect(byName.get("community_memberships")!.rowCount).toBe(3)
    expect(byName.get("content_translations")!.rowCount).toBe(2)
    expect(byName.get("community_assistant_chats")!.rowCount).toBe(4)
    expect(byName.get("community_jobs")!.rowCount).toBe(5)
    expect(byName.get("posts")!.rowCount).toBe(0)
    expect(byName.get("comments")!.rowCount).toBe(0)
    expect(inv.indexCount).toBeGreaterThan(0)
    expect(inv.measuredAt).toBeTruthy()
  })

  test("reports totalBytes null and an error for a missing database", async () => {
    const inv = await measureCommunityDatabase({
      communityId: "com_test_missing",
      source: "fixture-dir",
      databaseUrl: "file:/nonexistent/dir/missing.db",
      openClient: () => createClient({ url: "file:/nonexistent/dir/missing.db" }),
    })

    expect(inv.error).not.toBeNull()
    expect(inv.totalBytes).toBeNull()
    expect(inv.tables).toEqual([])
  })
})

describe("discoverFixtureBindings", () => {
  test("finds .db files in a directory and yields openClient per binding", async () => {
    const dir = await tmpCommunityDir()
    await writeFile(join(dir, "com_a.db"), "")
    await writeFile(join(dir, "com_b.db"), "")
    await writeFile(join(dir, "ignored.txt"), "")

    const bindings = await discoverFixtureBindings({ fixtureDir: dir })
    expect(bindings.map((b) => b.communityId).sort()).toEqual(["com_a", "com_b"])
    expect(bindings[0]?.source).toBe("fixture-dir")
    for (const binding of bindings) {
      const inv = await measureCommunityDatabase({
        communityId: binding.communityId,
        source: binding.source,
        databaseUrl: binding.databaseUrl,
        openClient: binding.openClient,
      })
      expect(typeof inv.error === "string" || inv.error === null).toBe(true)
    }
  })
})

describe("measureCommunities and summarize", () => {
  test("aggregates totals across multiple fixture communities", async () => {
    const dir = await tmpCommunityDir()
    const a = join(dir, "com_alpha.db")
    const b = join(dir, "com_beta.db")
    await applyCommunityMigrations(a, 1098)
    await applyCommunityMigrations(b, 1098)
    await seedSimpleCommunity(a, {
      communities: 1, memberships: 2, translations: 1, assistantChats: 1, jobs: 1,
    })
    await seedSimpleCommunity(b, {
      communities: 1, memberships: 5, translations: 0, assistantChats: 0, jobs: 0,
    })

    const bindings = await discoverFixtureBindings({ fixtureDir: dir })
    const report = await measureCommunities({ bindings })
    expect(report.totals.communities).toBe(2)
    expect(report.totals.measured).toBe(2)
    expect(report.totals.failed).toBe(0)
    expect(report.totals.holdouts).toBe(0)
    expect(report.totals.totalBytes).toBeGreaterThan(0)
    const byId = new Map(report.communities.map((c) => [c.communityId, c]))
    expect(byId.get("com_alpha")!.tables.find((t) => t.name === "community_memberships")!.rowCount).toBe(2)
    expect(byId.get("com_beta")!.tables.find((t) => t.name === "community_memberships")!.rowCount).toBe(5)
  })

  test("summarize counts holdouts and failures", () => {
    const inventories: CommunityInventory[] = [
      {
        communityId: "ok", source: "fixture-dir", databaseUrl: "file:ok",
        pageCount: 100, pageSize: 4096, totalBytes: 409_600,
        tables: [], indexCount: 0, holdout: false, error: null, measuredAt: "x",
      },
      {
        communityId: "huge", source: "fixture-dir", databaseUrl: "file:huge",
        pageCount: 1_000_000, pageSize: 8192, totalBytes: INVENTORY_HOLDOUT_BYTES + 1,
        tables: [], indexCount: 0, holdout: true, error: null, measuredAt: "x",
      },
      {
        communityId: "broken", source: "fixture-dir", databaseUrl: "file:broken",
        pageCount: null, pageSize: null, totalBytes: null,
        tables: [], indexCount: 0, holdout: false, error: "boom", measuredAt: "x",
      },
    ]
    const report = summarize(inventories)
    expect(report.totals.communities).toBe(3)
    expect(report.totals.measured).toBe(2)
    expect(report.totals.failed).toBe(1)
    expect(report.totals.holdouts).toBe(1)
    expect(report.totals.totalBytes).toBe(409_600 + INVENTORY_HOLDOUT_BYTES + 1)
  })
})
