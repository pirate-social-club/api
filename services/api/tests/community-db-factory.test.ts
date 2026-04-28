import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@libsql/client"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { encryptCommunityDbCredential } from "../src/lib/communities/community-db-credential-crypto"
import { enqueueCommunityJob } from "../src/lib/communities/jobs/store"
import type { CommunityDatabaseBindingRepository } from "../src/lib/communities/db-community-repository"
import { resolveCoreRepoPath } from "../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function applyPartialCommunitySchema(databasePath: string): Promise<void> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name TEXT PRIMARY KEY,
        migration_label TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    const migrationsDir = resolveCoreRepoPath("db/community-template/migrations", {
      serviceRoot: fileURLToPath(new URL("..", import.meta.url)),
    })
    const entries = (await readdir(migrationsDir))
      .filter((entry) => entry.endsWith(".sql"))
      .sort()
      .filter((entry) => Number.parseInt(entry.slice(0, 4), 10) <= 1023)

    for (const entry of entries) {
      const sql = await readFile(join(migrationsDir, entry), "utf8")
      for (const statement of splitSqlStatements(sql)) {
        for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
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

async function getTableColumns(databasePath: string, tableName: string): Promise<string[]> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute(`PRAGMA table_info(${tableName})`)
    return result.rows.map((row) => String(row.name))
  } finally {
    client.close()
  }
}

async function listTableNames(databasePath: string): Promise<string[]> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `)
    return result.rows.map((row) => String(row.name))
  } finally {
    client.close()
  }
}

function buildRepository(databasePath: string): CommunityDatabaseBindingRepository {
  return {
    async getPrimaryCommunityDatabaseBinding() {
      return {
        community_database_binding_id: "cdb_partial",
        community_id: "cmt_partial",
        binding_role: "primary",
        organization_slug: "local",
        group_name: "local",
        group_id: null,
        database_name: "community-cmt_partial",
        database_id: null,
        database_url: `file:${databasePath}`,
        location: null,
        requires_credentials: false,
        status: "active",
        transferred_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    },
    async getActiveCommunityDbCredential() {
      return null
    },
  }
}

describe("openCommunityDb", () => {
  test("does not run local migrations for remote provisioned community databases", async () => {
    const wrapKey = "11".repeat(32)
    const databaseUrl = "libsql://main-cmt-remote-test-pirate-social.aws-us-east-1.turso.io"
    const now = new Date().toISOString()
    const repo = {
      async getPrimaryCommunityDatabaseBinding() {
        return {
          community_database_binding_id: "cdb_remote",
          community_id: "cmt_remote",
          binding_role: "primary",
          organization_slug: "pirate-social",
          group_name: "region-aws-us-east-1",
          group_id: "grp_remote",
          database_name: "main-cmt-remote-test",
          database_id: "db_remote",
          database_url: databaseUrl,
          location: "aws-us-east-1",
          requires_credentials: true,
          status: "active",
          transferred_at: null,
          created_at: now,
          updated_at: now,
        }
      },
      async getActiveCommunityDbCredential() {
        return {
          community_db_credential_id: "cdc_remote",
          community_database_binding_id: "cdb_remote",
          credential_kind: "database_token",
          token_name: "worker-cmt_remote-v1",
          encrypted_token: encryptCommunityDbCredential({
            plaintextToken: "remote-token",
            wrapKey,
          }),
          encryption_key_version: 1,
          token_scope: "database",
          status: "active",
          issued_at: now,
          invalidated_at: null,
          expires_at: null,
          created_at: now,
          updated_at: now,
        }
      },
    } satisfies CommunityDatabaseBindingRepository

    const db = await openCommunityDb(
      {
        TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
      },
      repo,
      "cmt_remote",
    )

    expect(db.databaseUrl).toBe(databaseUrl)
    db.close()
  })

  test("applies pending template migrations for existing local community databases", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-db-factory-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath)

    const beforeTableNames = await listTableNames(databasePath)
    expect(beforeTableNames).not.toContain("comments")
    expect(beforeTableNames).not.toContain("comment_closure")
    expect(beforeTableNames).not.toContain("thread_snapshots")
    expect(beforeTableNames).not.toContain("donation_partners")

    const beforePostColumns = await getTableColumns(databasePath, "posts")
    expect(beforePostColumns).not.toContain("comment_count")
    expect(beforePostColumns).not.toContain("top_level_comment_count")
    expect(beforePostColumns).not.toContain("last_comment_at")

    const db = await openCommunityDb(
      {
        LOCAL_COMMUNITY_DB_ROOT: rootDir,
      },
      buildRepository(databasePath),
      "cmt_partial",
    )

    db.close()

    const tableNames = await listTableNames(databasePath)
    expect(tableNames).toContain("comments")
    expect(tableNames).toContain("comment_closure")
    expect(tableNames).toContain("comment_votes")
    expect(tableNames).toContain("thread_snapshots")
    expect(tableNames).toContain("donation_partners")
    expect(tableNames).toContain("purchase_settlement_effects")
    expect(tableNames).toContain("purchase_settlement_attempts")

    const postColumns = await getTableColumns(databasePath, "posts")
    expect(postColumns).toContain("comment_count")
    expect(postColumns).toContain("top_level_comment_count")
    expect(postColumns).toContain("last_comment_at")

    const assetColumns = await getTableColumns(databasePath, "assets")
    expect(assetColumns).toContain("story_royalty_policy_id")
    expect(assetColumns).toContain("story_derivative_parent_ip_ids_json")
    expect(assetColumns).toContain("story_royalty_registration_status")
    expect(assetColumns).toContain("display_title")

    const donationPartnerColumns = await getTableColumns(databasePath, "donation_partners")
    expect(donationPartnerColumns).toContain("payout_destination_ref")

    const allocationLegColumns = await getTableColumns(databasePath, "purchase_allocation_legs")
    expect(allocationLegColumns).toContain("provider_receipt_ref")
    expect(allocationLegColumns).toContain("tax_receipt_ref")
    expect(allocationLegColumns).toContain("attempt_count")

    const purchaseQuoteColumns = await getTableColumns(databasePath, "purchase_quotes")
    expect(purchaseQuoteColumns).toContain("settlement_mode")
    expect(purchaseQuoteColumns).toContain("funding_destination_address")

    const settlementEffectColumns = await getTableColumns(databasePath, "purchase_settlement_effects")
    expect(settlementEffectColumns).toContain("metadata_json")

    const settlementAttemptColumns = await getTableColumns(databasePath, "purchase_settlement_attempts")
    expect(settlementAttemptColumns).toContain("attempt_count")
    expect(settlementAttemptColumns).toContain("settlement_wallet_attachment_id")

    const purchaseColumns = await getTableColumns(databasePath, "purchases")
    expect(purchaseColumns).toContain("settlement_mode")

    const moderationCaseColumns = await getTableColumns(databasePath, "moderation_cases")
    expect(moderationCaseColumns).toContain("comment_id")

    const moderationActionColumns = await getTableColumns(databasePath, "moderation_actions")
    expect(moderationActionColumns).toContain("comment_id")
    expect(moderationActionColumns).toContain("previous_post_status")
    expect(moderationActionColumns).toContain("next_post_status")
  })

  test("enqueues community jobs after existing local databases are migrated", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-job-store-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath)

    const db = await openCommunityDb(
      {
        LOCAL_COMMUNITY_DB_ROOT: rootDir,
      },
      buildRepository(databasePath),
      "cmt_partial",
    )

    try {
      const now = new Date().toISOString()
      await db.client.execute({
        sql: `
          INSERT INTO communities (
            community_id, display_name, description, status, artist_identity_id, artist_governance_state,
            membership_mode, default_age_gate_policy, allow_anonymous_identity, anonymous_identity_scope,
            donation_partner_id, donation_policy_mode, donation_partner_status, governance_mode,
            settings_json, created_by_user_id, created_at, updated_at
          ) VALUES (
            ?1, ?2, NULL, 'active', NULL, 'fan_run',
            'open', 'none', 0, NULL,
            NULL, 'none', 'unconfigured', 'centralized',
            NULL, ?3, ?4, ?4
          )
        `,
        args: ["cmt_partial", "Partial Community", "usr_partial_owner", now],
      })

      const first = await enqueueCommunityJob({
        client: db.client,
        communityId: "cmt_partial",
        jobType: "comment_projection_sync",
        subjectType: "comment",
        subjectId: "cmt_01",
        payloadJson: JSON.stringify({ source_comment_id: "cmt_01" }),
        createdAt: now,
      })

      const second = await enqueueCommunityJob({
        client: db.client,
        communityId: "cmt_partial",
        jobType: "comment_projection_sync",
        subjectType: "comment",
        subjectId: "cmt_01",
        payloadJson: JSON.stringify({ source_comment_id: "cmt_01" }),
        createdAt: now,
      })

      expect(second.job_id).toBe(first.job_id)
      expect(second.status).toBe("queued")
    } finally {
      db.close()
    }
  })
})
