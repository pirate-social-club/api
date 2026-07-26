import { afterEach, describe, expect, test } from "bun:test"

import { createControlPlaneTestClient } from "../../../tests/helpers"
import type { UserRepository } from "../auth/repositories"
import { readProfileFollowState } from "./profile-follow-read-service"

const TARGET = "0x2222222222222222222222222222222222222222"
const VIEWER = "0x1111111111111111111111111111111111111111"
const NOW = "2026-07-26T00:00:00.000Z"
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

async function setup(status: "current" | "stale" = "current") {
  const database = await createControlPlaneTestClient()
  cleanups.push(database.cleanup)
  await database.client.batch([
    { sql: `CREATE TABLE efp_effective_follows (
      follower_address TEXT NOT NULL, followed_address TEXT NOT NULL,
      PRIMARY KEY (follower_address, followed_address))` },
    { sql: `CREATE TABLE efp_follow_counts (
      wallet_address TEXT PRIMARY KEY, follower_count INTEGER NOT NULL,
      following_count INTEGER NOT NULL, projection_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL)` },
    { sql: `CREATE TABLE efp_follow_projection_state (
      projection_key TEXT PRIMARY KEY, status TEXT NOT NULL,
      projection_revision INTEGER NOT NULL)` },
    {
      sql: "INSERT INTO efp_follow_projection_state VALUES ('effective-graph', ?1, 7)",
      args: [status],
    },
    { sql: `CREATE TABLE efp_follow_projection_chain_watermarks (
      chain_id INTEGER PRIMARY KEY, applied_through_block INTEGER NOT NULL,
      applied_through_block_hash TEXT NOT NULL, projection_revision INTEGER NOT NULL,
      last_successful_at TEXT NOT NULL, updated_at TEXT NOT NULL)` },
    {
      sql: "INSERT INTO efp_follow_projection_chain_watermarks VALUES (8453, 1234, '0x01', 7, ?1, ?1)",
      args: [NOW],
    },
  ], "write")
  return database.client
}

function users(wallets: Record<string, string | null>): UserRepository {
  return {
    async getWalletAttachmentsByUserId(userId) {
      const wallet = wallets[userId]
      return wallet
        ? [{
            wallet_attachment: `wallet-${userId}`,
            chain_namespace: "eip155:1",
            wallet_address: wallet,
            is_primary: true,
          }]
        : []
    },
  } as UserRepository
}

describe("profile EFP follow read model", () => {
  test("distinguishes a target with no canonical wallet from projection failure", async () => {
    const client = await setup("current")
    const result = await readProfileFollowState({
      client,
      users: users({}),
      targetUserId: "target",
      targetPublicUserId: "usr_target",
      viewerUserId: null,
    })

    expect(result.target_wallet).toEqual({ status: "no_wallet" })
    expect(result.counts).toEqual({
      status: "not_applicable",
      follower_count: null,
      following_count: null,
    })
    expect(result.projection.availability).toBe("current")
  })

  test("returns explicit unavailable values while the projection is stale", async () => {
    const client = await setup("stale")
    const result = await readProfileFollowState({
      client,
      users: users({ target: TARGET }),
      targetUserId: "target",
      targetPublicUserId: "usr_target",
      viewerUserId: "viewer",
    })

    expect(result.target_wallet.status).toBe("available")
    expect(result.relationship).toEqual({ status: "unavailable", viewer_follows: null })
    expect(result.counts).toEqual({
      status: "unavailable",
      follower_count: null,
      following_count: null,
    })
    expect(result.projection).toMatchObject({
      availability: "projection_stale",
      revision: "7",
      indexed_through_block: [{ chain_id: 8453, block_number: "1234" }],
    })
  })

  test("serves current materialized counts and relationship without full replay", async () => {
    const client = await setup("current")
    await client.batch([
      {
        sql: "INSERT INTO efp_follow_counts VALUES (?1, 12, 34, 7, ?2)",
        args: [TARGET, NOW],
      },
      {
        sql: "INSERT INTO efp_effective_follows VALUES (?1, ?2)",
        args: [VIEWER, TARGET],
      },
    ], "write")
    const result = await readProfileFollowState({
      client,
      users: users({ target: TARGET, viewer: VIEWER }),
      targetUserId: "target",
      targetPublicUserId: "usr_target",
      viewerUserId: "viewer",
    })

    expect(result.relationship).toEqual({ status: "current", viewer_follows: true })
    expect(result.counts).toEqual({
      status: "current",
      follower_count: 12,
      following_count: 34,
    })
  })

  test("keeps counts current while identifying a viewer with no wallet", async () => {
    const client = await setup("current")
    const result = await readProfileFollowState({
      client,
      users: users({ target: TARGET }),
      targetUserId: "target",
      targetPublicUserId: "usr_target",
      viewerUserId: "viewer",
    })

    expect(result.relationship).toEqual({ status: "viewer_no_wallet", viewer_follows: null })
    expect(result.counts).toEqual({
      status: "current",
      follower_count: 0,
      following_count: 0,
    })
  })
})
