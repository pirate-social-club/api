import { describe, expect, test } from "bun:test"
import {
  isWriteAllowedStatement,
  type ShardRpc,
  type ShardSqlStatement,
  type ShardResult,
  type ShardQueryResult,
} from "@pirate/api-shared"
import { makeCommunityD1Client } from "../community-d1-client"
import type { ResolvedCommunityBinding } from "../community-binding-resolver"
import type { PreparedLiveRoomCreate } from "./create-input"
import { createLiveRoomInTransaction } from "./service"
import { insertCommunityListingRow } from "../commerce/listing-service"

// Regression for the D1 buffered-write trap in publishLiveRoom: the combined
// "create live room + create its ticket listing" runs in ONE transaction("write").
// The routed D1 client buffers every statement into one atomic shard.batchWrite,
// where the write guard (isWriteAllowedStatement) rejects any non-DML. The old
// createCommunityListingInTransaction did membership/target/dup-check SELECTs and a
// readback inside that tx — broken on D1. The fix validates before the tx
// (prepareCommunityListingWrite) and inserts write-only here. This test drives the
// REAL buffering tx + REAL guard via a fake shard, asserting the combined tx body
// commits cleanly with no buffered read. Mirrors post-jobs-write-tx-guard.test.ts.

const COMMUNITY_ID = "cmt_pilot"

function bindingFor(communityId: string): ResolvedCommunityBinding {
  return {
    communityId,
    backend: "d1",
    provisioningState: "ready",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_PILOT",
    region: "enam",
    tursoDatabaseBindingId: null,
    decommissionedAt: null,
  } as ResolvedCommunityBinding
}

function makeGuardedFakeShard() {
  const seen: ShardSqlStatement[] = []
  const shard = {
    async batchWrite(input: {
      statements: ShardSqlStatement[]
    }): Promise<ShardResult<ShardQueryResult[]>> {
      for (const statement of input.statements) {
        if (!isWriteAllowedStatement(statement.sql)) {
          return {
            ok: false,
            code: "shard_write_not_allowed",
            message: `Statement rejected by shard write guard: ${statement.sql}`,
          }
        }
      }
      seen.push(...input.statements)
      return { ok: true, value: input.statements.map(() => ({ rows: [] })) }
    },
  } as unknown as ShardRpc
  return { shard, seen }
}

const PREPARED_ROOM: PreparedLiveRoomCreate = {
  title: "Paid Live",
  description: null,
  roomKind: "solo",
  accessMode: "paid",
  visibility: "public",
  guestUserId: null,
  eventStartAt: null,
  coverRef: null,
  recordingEnabled: false,
  allocations: [{ userId: "usr_host", role: "host", shareBps: 10_000 }],
  setlist: { status: "draft", items: [] },
}

describe("publishLiveRoom combined create+listing inside a D1 write transaction", () => {
  test("live room + ticket listing commit cleanly through the shard write guard (no buffered read)", async () => {
    const { shard, seen } = makeGuardedFakeShard()
    const client = makeCommunityD1Client(shard, bindingFor(COMMUNITY_ID))

    const tx = await client.transaction("write")
    // Mirrors publishLiveRoom's tx body: create the room, then insert its listing
    // (write-only; listing validation/config is resolved BEFORE the tx).
    const created = await createLiveRoomInTransaction({
      tx,
      userId: "usr_host",
      communityId: COMMUNITY_ID,
      prepared: PREPARED_ROOM,
    })
    await insertCommunityListingRow(
      tx,
      COMMUNITY_ID,
      {
        listingId: "lst_test_1",
        createdAt: "2026-06-22T00:00:00.000Z",
        assetId: null,
        liveRoomId: null,
        replayAssetId: null,
        status: "active",
        priceUsd: 9.99,
        regionalPricingPolicyJson: JSON.stringify({
          regional_pricing_enabled: false,
          donation_partner_id: null,
          donation_share_pct: null,
        }),
        vinylReleaseProvider: null,
        vinylReleaseUrl: null,
        createdByUserId: "usr_host",
      },
      created.liveRoomId,
    )

    // The bug surfaced at commit: a buffered SELECT would be rejected by the guard.
    await expect(tx.commit()).resolves.toBeUndefined()

    // Every statement that reached the shard must be a write — no read leaked in.
    expect(seen.length).toBeGreaterThan(0)
    for (const statement of seen) {
      expect(isWriteAllowedStatement(statement.sql)).toBe(true)
    }
    // The listing insert is part of the same atomic batch as the room writes.
    expect(seen.some((s) => /insert\s+into\s+listings/i.test(s.sql))).toBe(true)
    expect(seen.some((s) => /insert\s+into\s+live_rooms/i.test(s.sql))).toBe(true)
  })
})
