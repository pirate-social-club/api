import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import type { ShardRpc } from "@pirate/api-shared"
import type { Env } from "../../../env"
import type { CommunityDatabaseBindingRepository } from "../community-repository-types"
import { resetRuntimeCaches } from "../../../../tests/helpers"
import { loadCommunityLocalSnapshot } from "./repository"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

describe("loadCommunityLocalSnapshot", () => {
  test("propagates a routed shard schema failure instead of serializing defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "community-snapshot-failure-"))
    const databasePath = join(dir, "control-plane.db")
    const control = createClient({ url: `file:${databasePath}` })
    cleanup = async () => {
      control.close()
      await rm(dir, { recursive: true, force: true })
    }
    await control.execute(`
      CREATE TABLE community_database_routing (
        community_id TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        provisioning_state TEXT NOT NULL,
        shard_worker_id TEXT,
        binding_name TEXT,
        region TEXT,
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
          region, migrated_at, decommissioned_at, last_error_at, last_error_message,
          created_at, updated_at
        ) VALUES (?1, 'd1', 'ready', 'test-shard', 'DB_CMTY_SNAPSHOT_FAILURE',
                  'test', ?2, NULL, NULL, NULL, ?2, ?2)
      `,
      args: ["cmt_snapshot_failure", "2026-08-11T00:00:00.000Z"],
    })

    const shard = {
      async execute() {
        throw new Error("no such column: karaoke_enabled")
      },
    } as unknown as ShardRpc
    const env = {
      ENVIRONMENT: "test",
      COMMUNITY_D1_SHARD: shard,
      COMMUNITY_D1_SHARD_ROUTES: '{"test-shard":"COMMUNITY_D1_SHARD"}',
      CONTROL_PLANE_DATABASE_URL: `file:${databasePath}`,
    } as Env
    const repo = {
      async getPrimaryCommunityDatabaseBinding() {
        return null
      },
    } as CommunityDatabaseBindingRepository

    await expect(loadCommunityLocalSnapshot(env, repo, "cmt_snapshot_failure"))
      .rejects.toThrow("no such column: karaoke_enabled")
  })
})
