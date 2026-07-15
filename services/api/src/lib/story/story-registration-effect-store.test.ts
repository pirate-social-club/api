import { createClient } from "@libsql/client"
import { beforeEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  confirmStoryRegistrationEffect,
  failStoryRegistrationEffect,
  reserveStoryRegistrationEffect,
} from "./story-registration-effect-store"

const COMMUNITY_ID = "cmt_effect"
const ASSET_ID = "ast_effect"
const REQUEST = {
  communityId: COMMUNITY_ID,
  assetId: ASSET_ID,
  registrationKind: "original" as const,
  creatorWalletAddress: "0x1111111111111111111111111111111111111111",
  primaryContentHash: `0x${"22".repeat(32)}`,
}

let client: ReturnType<typeof createClient>

beforeEach(async () => {
  client = createClient({ url: ":memory:" })
  await client.execute("CREATE TABLE communities (community_id TEXT PRIMARY KEY)")
  await client.execute({ sql: "INSERT INTO communities (community_id) VALUES (?1)", args: [COMMUNITY_ID] })
  const migration = await readFile(
    new URL("../../../test-fixtures/db/community-template/migrations/1129_story_registration_effects.sql", import.meta.url),
    "utf8",
  )
  await client.executeMultiple(migration)
})

describe("Story registration effect journal", () => {
  test("is single-flight and replays the durable confirmed result", async () => {
    const first = await reserveStoryRegistrationEffect<{ storyIpId: string }>({
      client,
      ...REQUEST,
      now: "2026-07-15T10:00:00.000Z",
    })
    expect(first.kind).toBe("execute")
    if (first.kind !== "execute") throw new Error("expected execution reservation")

    await expect(reserveStoryRegistrationEffect({
      client,
      ...REQUEST,
      now: "2026-07-15T10:00:01.000Z",
    })).rejects.toThrow("story_registration_reconciliation_required:executing")

    await confirmStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      operationId: first.operationId,
      result: { storyIpId: "0xabc" },
      providerTxRef: `0x${"33".repeat(32)}`,
      now: "2026-07-15T10:00:02.000Z",
    })

    await expect(reserveStoryRegistrationEffect<{ storyIpId: string }>({
      client,
      ...REQUEST,
      now: "2026-07-15T10:00:03.000Z",
    })).resolves.toEqual({ kind: "confirmed", result: { storyIpId: "0xabc" } })
  })

  test("only a proven pre-broadcast failure can be reclaimed", async () => {
    const first = await reserveStoryRegistrationEffect({ client, ...REQUEST, now: "2026-07-15T10:00:00.000Z" })
    if (first.kind !== "execute") throw new Error("expected execution reservation")
    await failStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      operationId: first.operationId,
      reconciliationRequired: false,
      errorCode: "prebroadcast",
      now: "2026-07-15T10:00:01.000Z",
    })

    const retry = await reserveStoryRegistrationEffect({ client, ...REQUEST, now: "2026-07-15T10:00:02.000Z" })
    expect(retry.kind).toBe("execute")
    if (retry.kind !== "execute") throw new Error("expected retry reservation")
    expect(retry.operationId).not.toBe(first.operationId)
  })
})
