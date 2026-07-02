import { env } from "cloudflare:test"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { makeCommunityD1Client } from "../../src/lib/communities/community-d1-client"
import type { ResolvedCommunityBinding } from "../../src/lib/communities/community-binding-resolver"
// The shard's pure read/write logic (no cloudflare:workers import). Wired here to
// a REAL D1 binding so this runs the actual shard behavior in workerd — the RPC
// hop itself (api→shard service binding) is already proven live (PR2 staging
// reads), so the gap this closes is: buffered write tx → atomic batchWrite → D1.
import {
  runShardBatch,
  runShardRead,
  runShardWrite,
  type ShardEnv,
} from "../../../community-d1-shard/src/shard-read"

const PILOT = "cmt_pilot"
const OTHER = "cmt_other"

function shardEnv(): ShardEnv {
  return {
    DB_CMTY_PILOT: env.DB_CMTY_PILOT as unknown as D1Database,
    COMMUNITY_D1_BINDING_MAP_JSON: JSON.stringify({ [PILOT]: "DB_CMTY_PILOT" }),
  } as ShardEnv
}

// A shard RPC stub that delegates to the REAL shard logic against the REAL D1 —
// i.e. exactly what the deployed shard Worker's WorkerEntrypoint does.
const shard = {
  execute: (input: Parameters<typeof runShardRead>[1]) => runShardRead(shardEnv(), input),
  batch: (input: Parameters<typeof runShardBatch>[1]) => runShardBatch(shardEnv(), input),
  batchWrite: (input: Parameters<typeof runShardWrite>[1]) => runShardWrite(shardEnv(), input),
}

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
  await env.DB_CMTY_PILOT.exec(
    "CREATE TABLE IF NOT EXISTS community_rules (rule_id TEXT PRIMARY KEY, community_id TEXT NOT NULL, title TEXT, body TEXT, report_reason TEXT, position INTEGER, status TEXT, created_at TEXT, updated_at TEXT)",
  )
})

beforeEach(async () => {
  await env.DB_CMTY_PILOT.exec("DELETE FROM community_rules")
})

describe("Turso→D1 shard write path (real workerd + real D1)", () => {
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
    const direct = await env.DB_CMTY_PILOT.prepare(
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
    const after = await env.DB_CMTY_PILOT.prepare("SELECT count(*) AS n FROM community_rules").all()
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
    const after = await env.DB_CMTY_PILOT.prepare("SELECT count(*) AS n FROM community_rules").all()
    expect((after.results[0] as { n: number }).n).toBe(0)
  })

  it("rejects a SELECT smuggled into the write batch (shard write guard)", async () => {
    const client = makeCommunityD1Client(shard, bindingFor(PILOT))
    await expect(client.batch([{ sql: "SELECT 1" }], "write")).rejects.toMatchObject({
      code: "shard_write_not_allowed",
    })
  })
})
