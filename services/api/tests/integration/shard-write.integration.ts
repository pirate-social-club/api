import { env } from "cloudflare:test"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { makeCommunityD1Client } from "../../src/lib/communities/community-d1-client"
import type { ResolvedCommunityBinding } from "../../src/lib/communities/community-binding-resolver"
// The shard's pure read/write logic (no cloudflare:workers import). Wired here to
// a REAL D1 binding so this runs the actual shard behavior in workerd — the RPC
// hop itself (api→shard service binding) is already proven live (PR2 staging
// reads), so the gap this closes is: buffered write tx → atomic batchWrite → D1.
import {
  resetPoolCacheForTests,
  runShardBatch,
  runShardRead,
  runShardWrite,
  type ShardEnv,
} from "../../../community-d1-shard/src/shard-read"

const PILOT = "cmt_pilot"
const OTHER = "cmt_other"

function d1Env(): typeof env & { DB_CMTY_PILOT: D1Database; D1_POOL: D1Database } {
  return env as typeof env & { DB_CMTY_PILOT: D1Database; D1_POOL: D1Database }
}

function shardEnv(): ShardEnv {
  return {
    DB_CMTY_PILOT: d1Env().DB_CMTY_PILOT,
    D1_POOL: d1Env().D1_POOL,
    COMMUNITY_D1_BINDING_MAP_JSON: JSON.stringify({ [PILOT]: "DB_CMTY_PILOT" }),
  } as ShardEnv
}

// A shard RPC stub that delegates to the REAL shard logic against the REAL D1 —
// i.e. exactly what the deployed shard Worker's WorkerEntrypoint does.
const shard = {
  execute: (input: Parameters<typeof runShardRead>[1]) => runShardRead(shardEnv(), input),
  batch: (input: Parameters<typeof runShardBatch>[1]) => runShardBatch(shardEnv(), input),
  batchWrite: (input: Parameters<typeof runShardWrite>[1]) => runShardWrite(shardEnv(), input),
} as unknown as Parameters<typeof makeCommunityD1Client>[0]

function bindingFor(communityId: string): ResolvedCommunityBinding {
  return {
    communityId,
    provisioningState: "ready",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_PILOT",
    region: "enam",
    decommissionedAt: null,
  } as ResolvedCommunityBinding
}

beforeAll(async () => {
  await d1Env().D1_POOL.exec(
    "CREATE TABLE IF NOT EXISTS d1_pool (binding_name TEXT PRIMARY KEY, community_id TEXT UNIQUE, allocated_at TEXT, released_at TEXT, last_loaded_at TEXT, last_error TEXT, quarantine_until TEXT, version INTEGER NOT NULL DEFAULT 0)",
  )
  await d1Env().D1_POOL.prepare(
    "INSERT OR REPLACE INTO d1_pool (binding_name, community_id, allocated_at, version) VALUES (?1, ?2, ?3, 0)",
  ).bind("DB_CMTY_PILOT", PILOT, "t0").run()
  await d1Env().DB_CMTY_PILOT.exec(
    "CREATE TABLE IF NOT EXISTS community_rules (rule_id TEXT PRIMARY KEY, community_id TEXT NOT NULL, title TEXT, body TEXT, report_reason TEXT, position INTEGER, status TEXT, created_at TEXT, updated_at TEXT)",
  )
  await d1Env().DB_CMTY_PILOT.exec(
    "CREATE TABLE IF NOT EXISTS streak_batch_days (user_id TEXT NOT NULL, post_id TEXT NOT NULL, activity_date TEXT NOT NULL, study_attempt_count INTEGER NOT NULL DEFAULT 0, study_target_count INTEGER NOT NULL DEFAULT 10, qualified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, post_id, activity_date))",
  )
  await d1Env().DB_CMTY_PILOT.exec(
    "CREATE TABLE IF NOT EXISTS streak_batch_rows (user_id TEXT NOT NULL, post_id TEXT NOT NULL, activity_date TEXT NOT NULL, PRIMARY KEY (user_id, post_id, activity_date))",
  )
})

beforeEach(async () => {
  resetPoolCacheForTests()
  await d1Env().DB_CMTY_PILOT.exec("DELETE FROM community_rules")
  await d1Env().DB_CMTY_PILOT.exec("DELETE FROM streak_batch_days")
  await d1Env().DB_CMTY_PILOT.exec("DELETE FROM streak_batch_rows")
})

describe("D1 shard write path (real workerd + real D1)", () => {
  it("a buffered write transaction commits as ONE atomic batchWrite, mutating real D1", async () => {
    const client = makeCommunityD1Client(shard, bindingFor(PILOT))

    // Mirrors community-rule-settings-service: DELETE + INSERT inside one write tx.
    const tx = await client.transaction("write")
    await tx.execute({ sql: "DELETE FROM community_rules WHERE community_id = ?1", args: [PILOT] })
    await tx.execute({
      sql: "INSERT INTO community_rules (rule_id, community_id, title, body, report_reason, position, status, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)",
      args: ["rule_1", PILOT, "No spam", "Body", "other", 0, "active", "t0"],
    })
    await tx.commit()

    // (1) D1 state changed — verify directly against the real D1 binding.
    const direct = await d1Env().DB_CMTY_PILOT.prepare(
      "SELECT rule_id, title, status FROM community_rules WHERE community_id = ?1",
    )
      .bind(PILOT)
      .all()
    expect(direct.results).toEqual([{ rule_id: "rule_1", title: "No spam", status: "active" }])

    // (2) read-back THROUGH the D1 client (shard read RPC) returns the written row.
    const read = await client.execute({
      sql: "SELECT rule_id FROM community_rules WHERE community_id = ?1",
      args: [PILOT],
    })
    expect(read.rows).toEqual([{ rule_id: "rule_1" }])
  })

  it("rolling back a buffered tx writes nothing to D1", async () => {
    const client = makeCommunityD1Client(shard, bindingFor(PILOT))
    const tx = await client.transaction("write")
    await tx.execute({
      sql: "INSERT INTO community_rules (rule_id, community_id, status) VALUES (?1,?2,'active')",
      args: ["rule_rb", PILOT],
    })
    await tx.rollback()
    const after = await d1Env().DB_CMTY_PILOT.prepare("SELECT count(*) AS n FROM community_rules").all()
    expect((after.results[0] as { n: number }).n).toBe(0)
  })

  it("rejects a write for the WRONG community (shard allowlist) and writes nothing", async () => {
    const client = makeCommunityD1Client(shard, bindingFor(OTHER)) // not in the binding map
    const tx = await client.transaction("write")
    await tx.execute({
      sql: "INSERT INTO community_rules (rule_id, community_id, status) VALUES (?1,?2,'active')",
      args: ["rule_x", OTHER],
    })
    await expect(tx.commit()).rejects.toMatchObject({ code: "shard_binding_not_allowed" })
    const after = await d1Env().DB_CMTY_PILOT.prepare("SELECT count(*) AS n FROM community_rules").all()
    expect((after.results[0] as { n: number }).n).toBe(0)
  })

  it("rejects a SELECT smuggled into the write batch (shard write guard)", async () => {
    const client = makeCommunityD1Client(shard, bindingFor(PILOT))
    await expect(client.batch([{ sql: "SELECT 1" }], "write")).rejects.toMatchObject({
      code: "shard_write_not_allowed",
    })
  })

  it("later DML in a buffered write transaction sees an earlier upsert update in the same D1 batch", async () => {
    const client = makeCommunityD1Client(shard, bindingFor(PILOT))
    await d1Env().DB_CMTY_PILOT.prepare(
      "INSERT INTO streak_batch_days (user_id, post_id, activity_date, study_attempt_count, study_target_count, qualified) VALUES (?1, ?2, ?3, 9, 10, 0)",
    ).bind("usr_batch", "post_batch", "2026-07-05").run()

    const tx = await client.transaction("write")
    await tx.execute({
      sql: `
        INSERT INTO streak_batch_days (user_id, post_id, activity_date, study_attempt_count, study_target_count, qualified)
        VALUES (?1, ?2, ?3, 1, 10, 0)
        ON CONFLICT(user_id, post_id, activity_date) DO UPDATE SET
          study_attempt_count = streak_batch_days.study_attempt_count + 1,
          qualified = CASE
            WHEN streak_batch_days.study_attempt_count + 1 >= streak_batch_days.study_target_count THEN 1
            ELSE streak_batch_days.qualified
          END
      `,
      args: ["usr_batch", "post_batch", "2026-07-05"],
    })
    await tx.execute({
      sql: `
        INSERT INTO streak_batch_rows (user_id, post_id, activity_date)
        SELECT user_id, post_id, activity_date
        FROM streak_batch_days
        WHERE user_id = ?1
          AND post_id = ?2
          AND activity_date = ?3
          AND qualified = 1
      `,
      args: ["usr_batch", "post_batch", "2026-07-05"],
    })
    await tx.commit()

    const direct = await d1Env().DB_CMTY_PILOT.prepare(
      "SELECT user_id, post_id, activity_date FROM streak_batch_rows WHERE user_id = ?1",
    ).bind("usr_batch").all()
    expect(direct.results).toEqual([
      { user_id: "usr_batch", post_id: "post_batch", activity_date: "2026-07-05" },
    ])
  })
})
