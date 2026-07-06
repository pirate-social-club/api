import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, unlinkSync } from "node:fs"
import { createClient, type Client as LibsqlClient } from "@libsql/client"

import { listProjectedRoyaltyAllocationStoryAssets } from "./royalty-queries"
import type { Client } from "../sql-client"

const clients: LibsqlClient[] = []
const dbPaths: string[] = []

function appClient(client: LibsqlClient): Client {
  return client as unknown as Client
}

function freshDb(): LibsqlClient {
  const path = `/tmp/royalty-queries-${crypto.randomUUID()}.sqlite`
  dbPaths.push(path)
  const client = createClient({ url: `file:${path}` })
  clients.push(client)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  for (const path of dbPaths.splice(0)) {
    if (existsSync(path)) unlinkSync(path)
  }
})

async function createTables(client: LibsqlClient): Promise<void> {
  await client.execute(`
    CREATE TABLE story_royalty_allocation_projections (
      projection_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      story_ip_id TEXT NOT NULL,
      ip_royalty_vault TEXT,
      recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('creator', 'collaborator')),
      recipient_user_id TEXT,
      wallet_attachment_id TEXT,
      wallet_address_normalized TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      initial_share_bps INTEGER NOT NULL,
      allocation_fingerprint TEXT NOT NULL,
      distribution_status TEXT NOT NULL CHECK (distribution_status IN ('pending', 'verified', 'failed')),
      allocation_status TEXT NOT NULL,
      failure_reason TEXT,
      source_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE story_registered_asset_projections (
      projection_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      display_title TEXT,
      creator_user_id TEXT NOT NULL,
      asset_kind TEXT NOT NULL,
      license_preset TEXT,
      commercial_rev_share_pct INTEGER,
      story_ip_id TEXT NOT NULL,
      story_license_terms_id TEXT,
      source_post_id TEXT NOT NULL,
      source_post_status TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
}

async function insertProjection(client: LibsqlClient, input: {
  projectionId: string
  assetId: string
  storyIpId: string
  recipientUserId?: string | null
  walletAddress: string
  distributionStatus: "pending" | "verified" | "failed"
  updatedAt: string
}): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO story_royalty_allocation_projections (
        projection_id, community_id, asset_id, story_ip_id, ip_royalty_vault,
        recipient_kind, recipient_user_id, wallet_attachment_id, wallet_address_normalized,
        chain_id, initial_share_bps, allocation_fingerprint, distribution_status,
        allocation_status, failure_reason, source_updated_at, created_at, updated_at
      ) VALUES (
        ?1, 'com_1', ?2, ?3, NULL,
        'collaborator', ?4, NULL, ?5,
        1514, 1000, 'fp', ?6,
        'verified', NULL, ?7, ?7, ?7
      )
    `,
    args: [
      input.projectionId,
      input.assetId,
      input.storyIpId,
      input.recipientUserId ?? null,
      input.walletAddress,
      input.distributionStatus,
      input.updatedAt,
    ],
  })
}

async function insertRegisteredAsset(client: LibsqlClient, input: {
  projectionId: string
  assetId: string
  title: string
  storyIpId: string
  updatedAt: string
}): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO story_registered_asset_projections (
        projection_id, community_id, asset_id, display_title, creator_user_id,
        asset_kind, license_preset, commercial_rev_share_pct, story_ip_id,
        story_license_terms_id, source_post_id, source_post_status, source_updated_at,
        created_at, updated_at
      ) VALUES (
        ?1, 'com_1', ?2, ?3, 'usr_creator',
        'song_audio', 'commercial-use', 10, ?4,
        '42', 'pst_1', 'published', ?5,
        ?5, ?5
      )
    `,
    args: [input.projectionId, input.assetId, input.title, input.storyIpId, input.updatedAt],
  })
}

describe("listProjectedRoyaltyAllocationStoryAssets", () => {
  test("discovers verified allocation projections by recipient user or attached wallet", async () => {
    const client = freshDb()
    await createTables(client)
    await insertProjection(client, {
      projectionId: "p_user",
      assetId: "ast_user",
      storyIpId: "0x1111111111111111111111111111111111111111",
      recipientUserId: "usr_target",
      walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      distributionStatus: "verified",
      updatedAt: "2026-01-03T00:00:00Z",
    })
    await insertRegisteredAsset(client, {
      projectionId: "ra_user",
      assetId: "ast_user",
      title: "User Match",
      storyIpId: "0x1111111111111111111111111111111111111111",
      updatedAt: "2026-01-03T00:00:00Z",
    })
    await insertProjection(client, {
      projectionId: "p_wallet",
      assetId: "ast_wallet",
      storyIpId: "0x2222222222222222222222222222222222222222",
      walletAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      distributionStatus: "verified",
      updatedAt: "2026-01-02T00:00:00Z",
    })
    await insertRegisteredAsset(client, {
      projectionId: "ra_wallet",
      assetId: "ast_wallet",
      title: "Wallet Match",
      storyIpId: "0x2222222222222222222222222222222222222222",
      updatedAt: "2026-01-02T00:00:00Z",
    })

    const rows = await listProjectedRoyaltyAllocationStoryAssets({
      client: appClient(client),
      userId: "usr_target",
      walletAddressesNormalized: ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    })

    expect(rows.map((row) => row.asset_id)).toEqual(["ast_user", "ast_wallet"])
    expect(rows.map((row) => row.display_title)).toEqual(["User Match", "Wallet Match"])
  })

  test("does not expose pending or failed allocation projections as claimable candidates", async () => {
    const client = freshDb()
    await createTables(client)
    await insertProjection(client, {
      projectionId: "p_pending",
      assetId: "ast_pending",
      storyIpId: "0x3333333333333333333333333333333333333333",
      recipientUserId: "usr_target",
      walletAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
      distributionStatus: "pending",
      updatedAt: "2026-01-03T00:00:00Z",
    })
    await insertProjection(client, {
      projectionId: "p_failed",
      assetId: "ast_failed",
      storyIpId: "0x4444444444444444444444444444444444444444",
      recipientUserId: "usr_target",
      walletAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
      distributionStatus: "failed",
      updatedAt: "2026-01-02T00:00:00Z",
    })

    await expect(listProjectedRoyaltyAllocationStoryAssets({
      client: appClient(client),
      userId: "usr_target",
      walletAddressesNormalized: ["0xcccccccccccccccccccccccccccccccccccccccc"],
    })).resolves.toEqual([])
  })
})
