import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, unlinkSync } from "node:fs"
import { createClient, type Client as LibsqlClient } from "@libsql/client"

import {
  ROYALTY_ALLOCATION_VERSION,
  assertExistingAssetAllocationMatches,
  buildAllocationInsertStatements,
  buildAllocationRows,
  computeAllocationFingerprint,
  fingerprintForRequest,
  listPendingStoryRoyaltyAllocationAssets,
  loadStoryRoyaltySharesForAsset,
  markStoryRoyaltyAllocationRegistrationPendingVerification,
  persistAssetWithAllocations,
  resolveAllocationChainId,
  verifyStoryRoyaltyAllocationForAsset,
  type StoryRoyaltyVaultReader,
} from "./royalty-allocations"
import {
  loadStoryRoyaltyAllocationProjectionRows,
  syncStoryRoyaltyAllocationProjectionForAsset,
} from "./royalty-allocation-projection"
import type { Client, InStatement } from "../../sql-client"
import type { RoyaltyAllocationRequest } from "../../../types"

const CREATOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const COLLAB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const AENEID = 1315
const MAINNET = 1514

function split(): RoyaltyAllocationRequest[] {
  return [
    { recipient_kind: "creator", wallet_address: CREATOR, share_bps: 9000 },
    { recipient_kind: "collaborator", wallet_address: COLLAB, share_bps: 1000 },
  ]
}

// @libsql/client's Client implements execute/transaction with shapes structurally
// equivalent to the app's sql-client interface; bridge the nominal type gap once here.
function appClient(client: LibsqlClient): Client {
  return client as unknown as Client
}

const clients: LibsqlClient[] = []
const dbPaths: string[] = []
function freshDb(): LibsqlClient {
  // File-backed (not :memory:) so the write transaction shares the same database
  // as the setup/assertion connections.
  const path = `/tmp/royalty-allocations-${crypto.randomUUID()}.sqlite`
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
    CREATE TABLE assets (
      asset_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      royalty_allocation_status TEXT NOT NULL DEFAULT 'none',
      royalty_allocation_version INTEGER NOT NULL DEFAULT 1,
      royalty_allocation_fingerprint TEXT,
      royalty_allocation_projection_synced INTEGER NOT NULL DEFAULT 1,
      story_ip_id TEXT,
      ip_royalty_vault TEXT,
      royalty_vault_total_supply TEXT,
      royalty_vault_decimals INTEGER,
      royalty_allocation_effect_key TEXT,
      royalty_allocation_tx_hash TEXT,
      royalty_allocation_registered_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z'
    )
  `)
  await client.execute(`
    CREATE TABLE initial_royalty_allocations (
      allocation_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      community_id TEXT NOT NULL,
      recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('creator', 'collaborator')),
      recipient_user_id TEXT,
      wallet_attachment_id TEXT,
      wallet_address_normalized TEXT NOT NULL,
      wallet_address_display TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      share_bps INTEGER NOT NULL CHECK (share_bps > 0 AND share_bps <= 10000),
      expected_rt_units TEXT,
      distribution_status TEXT NOT NULL DEFAULT 'pending',
      verified_rt_units TEXT,
      failure_reason TEXT,
      position INTEGER NOT NULL CHECK (position >= 0),
      allocation_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      registered_at TEXT
    )
  `)
  await client.execute(`CREATE UNIQUE INDEX idx_alloc_asset_wallet ON initial_royalty_allocations(asset_id, wallet_address_normalized)`)
  await client.execute(`CREATE UNIQUE INDEX idx_alloc_one_creator ON initial_royalty_allocations(asset_id) WHERE recipient_kind = 'creator'`)
  await client.execute(`CREATE UNIQUE INDEX idx_alloc_position ON initial_royalty_allocations(asset_id, position)`)
}

async function createProjectionTable(client: LibsqlClient): Promise<void> {
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
      initial_share_bps INTEGER NOT NULL CHECK (initial_share_bps > 0 AND initial_share_bps <= 10000),
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
    CREATE UNIQUE INDEX idx_projection_unique
    ON story_royalty_allocation_projections(community_id, asset_id, wallet_address_normalized)
  `)
}

const assetInsertFor = (assetId: string, fingerprint: string): InStatement => ({
  sql: `
    INSERT INTO assets (
      asset_id, community_id, royalty_allocation_status, royalty_allocation_version,
      royalty_allocation_fingerprint, royalty_allocation_projection_synced
    ) VALUES (?1, ?2, 'draft', ?3, ?4, 0)
  `,
  args: [assetId, "com_1", ROYALTY_ALLOCATION_VERSION, fingerprint],
})

const snapshot = { walletAddressNormalized: CREATOR, walletAttachmentId: "wa_1" }

async function insertAllocationAsset(client: LibsqlClient, assetId: string, allocations = split()): Promise<void> {
  const fingerprint = await fingerprintForRequest(allocations, AENEID)
  await persistAssetWithAllocations({
    client: appClient(client),
    assetInsert: assetInsertFor(assetId, fingerprint),
    allocationStatements: buildAllocationInsertStatements(buildAllocationRows({
      assetId,
      communityId: "com_1",
      creatorUserId: "usr_author",
      allocations,
      fingerprint,
      creator: snapshot,
      chainId: AENEID,
      now: "2026-01-01T00:00:00Z",
      newId: () => crypto.randomUUID(),
    })),
  })
}

describe("resolveAllocationChainId", () => {
  test("resolves Aeneid (1315) by default", () => {
    expect(resolveAllocationChainId({ STORY_CHAIN_ID: "" })).toBe(AENEID)
  })

  test("resolves mainnet (1514) from runtime config", () => {
    expect(resolveAllocationChainId({ STORY_CHAIN_ID: "1514" })).toBe(MAINNET)
  })

  test("rejects an unsupported chain id", () => {
    expect(() => resolveAllocationChainId({ STORY_CHAIN_ID: "1" })).toThrow(/not supported/)
  })
})

describe("computeAllocationFingerprint", () => {
  test("is reorder-stable: declared order does not change the fingerprint", async () => {
    const forward = await computeAllocationFingerprint({
      version: 1, chainId: AENEID,
      allocations: [{ walletAddressNormalized: CREATOR, shareBps: 9000 }, { walletAddressNormalized: COLLAB, shareBps: 1000 }],
    })
    const reversed = await computeAllocationFingerprint({
      version: 1, chainId: AENEID,
      allocations: [{ walletAddressNormalized: COLLAB, shareBps: 1000 }, { walletAddressNormalized: CREATOR, shareBps: 9000 }],
    })
    expect(forward).toBe(reversed)
  })

  test("is bound to the resolved chain (Aeneid != mainnet)", async () => {
    const aeneid = await fingerprintForRequest(split(), AENEID)
    const mainnet = await fingerprintForRequest(split(), MAINNET)
    expect(aeneid).not.toBe(mainnet)
  })

  test("changes when a share changes", async () => {
    const a = await fingerprintForRequest(split(), AENEID)
    const b = await fingerprintForRequest([
      { recipient_kind: "creator", wallet_address: CREATOR, share_bps: 8000 },
      { recipient_kind: "collaborator", wallet_address: COLLAB, share_bps: 2000 },
    ], AENEID)
    expect(a).not.toBe(b)
  })

  test("is case-insensitive on addresses (request mixed-case == normalized)", async () => {
    const lower = await fingerprintForRequest(split(), AENEID)
    const upper = await fingerprintForRequest([
      { recipient_kind: "creator", wallet_address: CREATOR.toUpperCase().replace("0X", "0x"), share_bps: 9000 },
      { recipient_kind: "collaborator", wallet_address: COLLAB, share_bps: 1000 },
    ], AENEID)
    expect(lower).toBe(upper)
  })
})

describe("buildAllocationRows", () => {
  const snapshot = { walletAddressNormalized: CREATOR, walletAttachmentId: "wa_1" }

  test("snapshots the creator and preserves declared order; collaborators get null user/attachment", () => {
    const rows = buildAllocationRows({
      assetId: "ast_1", communityId: "com_1", creatorUserId: "usr_author",
      allocations: split(), fingerprint: "fp", creator: snapshot, chainId: AENEID,
      now: "2026-01-01T00:00:00Z", newId: () => "alloc_id",
    })
    expect(rows.map((row) => row.position)).toEqual([0, 1])
    const creator = rows[0]
    expect(creator.recipientUserId).toBe("usr_author")
    expect(creator.walletAttachmentId).toBe("wa_1")
    expect(creator.chainId).toBe(AENEID)
    // Collaborator wallets are externally declared and intentionally unverified.
    const collaborator = rows[1]
    expect(collaborator.recipientUserId).toBeNull()
    expect(collaborator.walletAttachmentId).toBeNull()
    expect(collaborator.walletAddressNormalized).toBe(COLLAB)
  })

  test("persists the resolved chain id on every row", () => {
    const rows = buildAllocationRows({
      assetId: "ast_1", communityId: "com_1", creatorUserId: "usr_author",
      allocations: split(), fingerprint: "fp", creator: snapshot, chainId: MAINNET,
      now: "2026-01-01T00:00:00Z", newId: () => "alloc_id",
    })
    expect(rows.every((row) => row.chainId === MAINNET)).toBe(true)
  })

  test("rejects a creator address that does not match the server-resolved primary wallet", () => {
    expect(() => buildAllocationRows({
      assetId: "ast_1", communityId: "com_1", creatorUserId: "usr_author",
      allocations: [
        { recipient_kind: "creator", wallet_address: COLLAB, share_bps: 9000 },
        { recipient_kind: "collaborator", wallet_address: CREATOR, share_bps: 1000 },
      ],
      fingerprint: "fp", creator: snapshot, chainId: AENEID, now: "2026-01-01T00:00:00Z", newId: () => "id",
    })).toThrow(/creator wallet must match/)
  })
})

describe("persistAssetWithAllocations", () => {
  const snapshot = { walletAddressNormalized: CREATOR, walletAttachmentId: "wa_1" }
  let counter = 0
  const rowsFor = (assetId: string, fingerprint: string) => buildAllocationRows({
    assetId, communityId: "com_1", creatorUserId: "usr_author", allocations: split(),
    fingerprint, creator: snapshot, chainId: AENEID, now: "2026-01-01T00:00:00Z",
    newId: () => `alloc_${(counter += 1)}`,
  })

  test("commits asset and allocation rows together", async () => {
    const client = freshDb()
    await createTables(client)
    const fingerprint = await fingerprintForRequest(split(), AENEID)
    await persistAssetWithAllocations({
      client: appClient(client),
      assetInsert: assetInsertFor("ast_ok", fingerprint),
      allocationStatements: buildAllocationInsertStatements(rowsFor("ast_ok", fingerprint)),
    })
    const assets = await client.execute({ sql: `SELECT royalty_allocation_status FROM assets WHERE asset_id = ?1`, args: ["ast_ok"] })
    expect(assets.rows).toHaveLength(1)
    expect(assets.rows[0].royalty_allocation_status).toBe("draft")
    const allocs = await client.execute({ sql: `SELECT COUNT(*) AS n FROM initial_royalty_allocations WHERE asset_id = ?1`, args: ["ast_ok"] })
    expect(Number(allocs.rows[0].n)).toBe(2)
  })

  test("rolls back the asset when an allocation insert fails", async () => {
    const client = freshDb()
    await createTables(client)
    const fingerprint = await fingerprintForRequest(split(), AENEID)
    const good = buildAllocationInsertStatements(rowsFor("ast_rollback", fingerprint))
    // A second creator row violates the one-creator unique index mid-transaction.
    const badCreator: InStatement = { ...good[0], args: [...(good[0].args as unknown[])] }
    ;(badCreator.args as unknown[])[0] = "alloc_dup_creator"
    ;(badCreator.args as unknown[])[6] = "0xcccccccccccccccccccccccccccccccccccccccc" // unique wallet
    ;(badCreator.args as unknown[])[10] = 2 // unique position
    await expect(persistAssetWithAllocations({
      client: appClient(client),
      assetInsert: assetInsertFor("ast_rollback", fingerprint),
      allocationStatements: [...good, badCreator],
    })).rejects.toThrow()
    const assets = await client.execute({ sql: `SELECT COUNT(*) AS n FROM assets WHERE asset_id = ?1`, args: ["ast_rollback"] })
    expect(Number(assets.rows[0].n)).toBe(0)
    const allocs = await client.execute({ sql: `SELECT COUNT(*) AS n FROM initial_royalty_allocations WHERE asset_id = ?1`, args: ["ast_rollback"] })
    expect(Number(allocs.rows[0].n)).toBe(0)
  })
})

describe("assertExistingAssetAllocationMatches (idempotent retry)", () => {
  test("passes when the retry fingerprint matches the stored asset", async () => {
    const client = freshDb()
    await createTables(client)
    const fingerprint = await fingerprintForRequest(split(), AENEID)
    await client.execute(assetInsertFor("ast_retry", fingerprint))
    await expect(assertExistingAssetAllocationMatches({
      client: appClient(client),
      communityId: "com_1", assetId: "ast_retry", requestedFingerprint: fingerprint,
    })).resolves.toBeUndefined()
  })

  test("rejects a retry whose split differs from the stored asset", async () => {
    const client = freshDb()
    await createTables(client)
    const stored = await fingerprintForRequest(split(), AENEID)
    await client.execute(assetInsertFor("ast_mismatch", stored))
    const different = await fingerprintForRequest([
      { recipient_kind: "creator", wallet_address: CREATOR, share_bps: 7000 },
      { recipient_kind: "collaborator", wallet_address: COLLAB, share_bps: 3000 },
    ], AENEID)
    await expect(assertExistingAssetAllocationMatches({
      client: appClient(client),
      communityId: "com_1", assetId: "ast_mismatch", requestedFingerprint: different,
    })).rejects.toThrow(/do not match/)
  })
})

describe("Story royalty token share registration", () => {
  test("loads persisted bps as exact Story percentage shares", async () => {
    const client = freshDb()
    await createTables(client)
    await insertAllocationAsset(client, "ast_story_shares")

    const shares = await loadStoryRoyaltySharesForAsset({
      client: appClient(client),
      communityId: "com_1",
      assetId: "ast_story_shares",
    })

    expect(shares).toEqual([
      { walletAddressNormalized: CREATOR, shareBps: 9000, percentage: 90 },
      { walletAddressNormalized: COLLAB, shareBps: 1000, percentage: 10 },
    ])
  })

  test("loads sub-percent bps shares as decimal Story percentages", async () => {
    const client = freshDb()
    await createTables(client)
    await insertAllocationAsset(client, "ast_fractional", [
      { recipient_kind: "creator", wallet_address: CREATOR, share_bps: 6667 },
      { recipient_kind: "collaborator", wallet_address: COLLAB, share_bps: 3333 },
    ])

    await expect(loadStoryRoyaltySharesForAsset({
      client: appClient(client),
      communityId: "com_1",
      assetId: "ast_fractional",
    })).resolves.toEqual([
      { walletAddressNormalized: CREATOR, shareBps: 6667, percentage: 66.67 },
      { walletAddressNormalized: COLLAB, shareBps: 3333, percentage: 33.33 },
    ])
  })

  test("records Story distribution tx and leaves allocations pending verification", async () => {
    const client = freshDb()
    await createTables(client)
    await insertAllocationAsset(client, "ast_registered")

    await markStoryRoyaltyAllocationRegistrationPendingVerification({
      client: appClient(client),
      communityId: "com_1",
      assetId: "ast_registered",
      ipRoyaltyVault: "0xcccccccccccccccccccccccccccccccccccccccc",
      distributionTxHash: "0xtx",
      registeredAt: "2026-01-02T00:00:00Z",
    })

    const asset = await client.execute({
      sql: `
        SELECT royalty_allocation_status, royalty_allocation_effect_key, royalty_allocation_tx_hash, ip_royalty_vault,
               royalty_allocation_projection_synced
        FROM assets
        WHERE asset_id = ?1
      `,
      args: ["ast_registered"],
    })
    expect(asset.rows[0]).toMatchObject({
      royalty_allocation_status: "verification_pending",
      royalty_allocation_effect_key: `ast_registered:${await fingerprintForRequest(split(), AENEID)}`,
      royalty_allocation_tx_hash: "0xtx",
      ip_royalty_vault: "0xcccccccccccccccccccccccccccccccccccccccc",
      royalty_allocation_projection_synced: 0,
    })
    const rows = await client.execute({
      sql: `
        SELECT distribution_status, registered_at
        FROM initial_royalty_allocations
        WHERE asset_id = ?1
        ORDER BY position ASC
      `,
      args: ["ast_registered"],
    })
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows.every((row) => row.distribution_status === "pending")).toBe(true)
    expect(rows.rows.every((row) => row.registered_at === "2026-01-02T00:00:00Z")).toBe(true)
  })
})

describe("loadStoryRoyaltyAllocationProjectionRows", () => {
  test("loads projectable allocation rows only after Story IP registration", async () => {
    const client = freshDb()
    await createTables(client)
    const fingerprint = await fingerprintForRequest(split(), AENEID)
    await persistAssetWithAllocations({
      client: appClient(client),
      assetInsert: assetInsertFor("ast_projected", fingerprint),
      allocationStatements: buildAllocationInsertStatements(buildAllocationRows({
        assetId: "ast_projected",
        communityId: "com_1",
        creatorUserId: "usr_author",
        allocations: split(),
        fingerprint,
        creator: snapshot,
        chainId: AENEID,
        now: "2026-01-01T00:00:00Z",
        newId: () => crypto.randomUUID(),
      })),
    })
    await client.execute({
      sql: `
        UPDATE assets
        SET story_ip_id = ?1,
            ip_royalty_vault = ?2,
            updated_at = ?3
        WHERE asset_id = ?4
      `,
      args: ["0xip", "0xvault", "2026-01-02T00:00:00Z", "ast_projected"],
    })

    const rows = await loadStoryRoyaltyAllocationProjectionRows({
      client: appClient(client),
      communityId: "com_1",
      assetId: "ast_projected",
    })

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      communityId: "com_1",
      assetId: "ast_projected",
      storyIpId: "0xip",
      ipRoyaltyVault: "0xvault",
      recipientKind: "creator",
      recipientUserId: "usr_author",
      walletAttachmentId: "wa_1",
      walletAddressNormalized: CREATOR,
      chainId: AENEID,
      initialShareBps: 9000,
      allocationFingerprint: fingerprint,
      distributionStatus: "pending",
      allocationStatus: "draft",
      sourceUpdatedAt: "2026-01-02T00:00:00Z",
    })
  })

  test("does not project draft allocations before Story IP registration", async () => {
    const client = freshDb()
    await createTables(client)
    const fingerprint = await fingerprintForRequest(split(), AENEID)
    await persistAssetWithAllocations({
      client: appClient(client),
      assetInsert: assetInsertFor("ast_no_ip", fingerprint),
      allocationStatements: buildAllocationInsertStatements(buildAllocationRows({
        assetId: "ast_no_ip",
        communityId: "com_1",
        creatorUserId: "usr_author",
        allocations: split(),
        fingerprint,
        creator: snapshot,
        chainId: AENEID,
        now: "2026-01-01T00:00:00Z",
        newId: () => crypto.randomUUID(),
      })),
    })

    await expect(loadStoryRoyaltyAllocationProjectionRows({
      client: appClient(client),
      communityId: "com_1",
      assetId: "ast_no_ip",
    })).resolves.toEqual([])
  })

  test("syncs rows to the control plane and marks the asset projection-synced", async () => {
    const communityClient = freshDb()
    const controlPlaneClient = freshDb()
    await createTables(communityClient)
    await createProjectionTable(controlPlaneClient)
    const fingerprint = await fingerprintForRequest(split(), AENEID)
    await persistAssetWithAllocations({
      client: appClient(communityClient),
      assetInsert: assetInsertFor("ast_sync", fingerprint),
      allocationStatements: buildAllocationInsertStatements(buildAllocationRows({
        assetId: "ast_sync",
        communityId: "com_1",
        creatorUserId: "usr_author",
        allocations: split(),
        fingerprint,
        creator: snapshot,
        chainId: AENEID,
        now: "2026-01-01T00:00:00Z",
        newId: () => crypto.randomUUID(),
      })),
    })
    await communityClient.execute({
      sql: `
        UPDATE assets
        SET story_ip_id = ?1,
            updated_at = ?2
        WHERE asset_id = ?3
      `,
      args: ["0xip", "2026-01-02T00:00:00Z", "ast_sync"],
    })

    await expect(syncStoryRoyaltyAllocationProjectionForAsset({
      env: {} as never,
      client: appClient(communityClient),
      controlPlaneClient: appClient(controlPlaneClient),
      communityId: "com_1",
      assetId: "ast_sync",
    })).resolves.toEqual({ projectedRows: 2 })

    const projected = await controlPlaneClient.execute({
      sql: `
        SELECT recipient_kind, wallet_address_normalized, initial_share_bps, allocation_status
        FROM story_royalty_allocation_projections
        WHERE community_id = ?1 AND asset_id = ?2
        ORDER BY initial_share_bps DESC
      `,
      args: ["com_1", "ast_sync"],
    })
    expect(projected.rows).toHaveLength(2)
    expect(projected.rows[0]).toMatchObject({
      recipient_kind: "creator",
      wallet_address_normalized: CREATOR,
      initial_share_bps: 9000,
      allocation_status: "draft",
    })
    const asset = await communityClient.execute({
      sql: `SELECT royalty_allocation_projection_synced FROM assets WHERE asset_id = ?1`,
      args: ["ast_sync"],
    })
    expect(Number(asset.rows[0].royalty_allocation_projection_synced)).toBe(1)
  })
})

describe("story royalty allocation vault verification", () => {
  function vaultReader(input: {
    totalSupply: bigint
    balances: Record<string, bigint>
    decimals?: number
  }): StoryRoyaltyVaultReader {
    return {
      totalSupply: async () => input.totalSupply,
      decimals: async () => input.decimals ?? 18,
      balanceOf: async ({ walletAddress }) => input.balances[walletAddress] ?? 0n,
    }
  }

  async function registeredPendingAsset(client: LibsqlClient, assetId = "ast_verify"): Promise<void> {
    await insertAllocationAsset(client, assetId)
    await client.execute({
      sql: `
        UPDATE assets
        SET story_ip_id = ?1,
            ip_royalty_vault = ?2,
            royalty_allocation_status = 'verification_pending',
            royalty_allocation_registered_at = ?3
        WHERE asset_id = ?4
      `,
      args: [
        "0x1111111111111111111111111111111111111111",
        "0xcccccccccccccccccccccccccccccccccccccccc",
        "2026-01-02T00:00:00Z",
        assetId,
      ],
    })
    await client.execute({
      sql: `
        UPDATE initial_royalty_allocations
        SET registered_at = ?2
        WHERE asset_id = ?1
      `,
      args: [assetId, "2026-01-02T00:00:00Z"],
    })
  }

  test("lists pending Story royalty allocation assets in registration order", async () => {
    const client = freshDb()
    await createTables(client)
    await registeredPendingAsset(client, "ast_one")
    await registeredPendingAsset(client, "ast_two")
    await client.execute({
      sql: `UPDATE assets SET royalty_allocation_status = 'verified' WHERE asset_id = ?1`,
      args: ["ast_two"],
    })

    const rows = await listPendingStoryRoyaltyAllocationAssets({
      client: appClient(client),
      limit: 10,
    })

    expect(rows).toEqual([{
      communityId: "com_1",
      assetId: "ast_one",
      storyIpId: "0x1111111111111111111111111111111111111111",
      ipRoyaltyVault: "0xcccccccccccccccccccccccccccccccccccccccc",
    }])
  })

  test("marks allocation rows and asset verified when vault balances meet expected shares", async () => {
    const client = freshDb()
    await createTables(client)
    await registeredPendingAsset(client)

    const result = await verifyStoryRoyaltyAllocationForAsset({
      client: appClient(client),
      communityId: "com_1",
      assetId: "ast_verify",
      checkedAt: "2026-01-03T00:00:00Z",
      vaultReader: vaultReader({
        totalSupply: 1_000_000n,
        balances: {
          [CREATOR]: 900_001n,
          [COLLAB]: 100_000n,
        },
      }),
    })

    expect(result).toMatchObject({
      status: "verified",
      assetId: "ast_verify",
      checkedRows: 2,
      totalSupply: "1000000",
      decimals: 18,
    })
    const asset = await client.execute({
      sql: `
        SELECT royalty_allocation_status, royalty_vault_total_supply, royalty_vault_decimals,
               royalty_allocation_projection_synced, updated_at
        FROM assets
        WHERE asset_id = ?1
      `,
      args: ["ast_verify"],
    })
    expect(asset.rows[0]).toMatchObject({
      royalty_allocation_status: "verified",
      royalty_vault_total_supply: "1000000",
      royalty_vault_decimals: 18,
      royalty_allocation_projection_synced: 0,
      updated_at: "2026-01-03T00:00:00Z",
    })
    const allocations = await client.execute({
      sql: `
        SELECT wallet_address_normalized, distribution_status, expected_rt_units, verified_rt_units, failure_reason
        FROM initial_royalty_allocations
        WHERE asset_id = ?1
        ORDER BY position ASC
      `,
      args: ["ast_verify"],
    })
    expect(allocations.rows).toEqual([
      {
        wallet_address_normalized: CREATOR,
        distribution_status: "verified",
        expected_rt_units: "900000",
        verified_rt_units: "900001",
        failure_reason: null,
      },
      {
        wallet_address_normalized: COLLAB,
        distribution_status: "verified",
        expected_rt_units: "100000",
        verified_rt_units: "100000",
        failure_reason: null,
      },
    ])
  })

  test("keeps allocations pending when a vault balance does not match", async () => {
    const client = freshDb()
    await createTables(client)
    await registeredPendingAsset(client)

    const result = await verifyStoryRoyaltyAllocationForAsset({
      client: appClient(client),
      communityId: "com_1",
      assetId: "ast_verify",
      vaultReader: vaultReader({
        totalSupply: 1_000_000n,
        balances: {
          [CREATOR]: 899_999n,
          [COLLAB]: 100_000n,
        },
      }),
    })

    expect(result.status).toBe("pending")
    expect(result).toMatchObject({ reason: `royalty_vault_balance_mismatch:${CREATOR}:899999:900000` })
    const asset = await client.execute({
      sql: `
        SELECT royalty_allocation_status, royalty_allocation_projection_synced
        FROM assets
        WHERE asset_id = ?1
      `,
      args: ["ast_verify"],
    })
    expect(asset.rows[0]).toMatchObject({
      royalty_allocation_status: "verification_pending",
      royalty_allocation_projection_synced: 0,
    })
    const allocations = await client.execute({
      sql: `
        SELECT distribution_status, verified_rt_units, failure_reason
        FROM initial_royalty_allocations
        WHERE asset_id = ?1
        ORDER BY position ASC
      `,
      args: ["ast_verify"],
    })
    expect(allocations.rows.every((row) => row.distribution_status === "pending")).toBe(true)
    expect(allocations.rows.every((row) => row.verified_rt_units == null)).toBe(true)
    expect(String(allocations.rows[0].failure_reason)).toContain("royalty_vault_balance_mismatch")
  })
})
