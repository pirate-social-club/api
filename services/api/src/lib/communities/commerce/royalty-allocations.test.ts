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
  persistAssetWithAllocations,
  resolveAllocationChainId,
  resolveRoyaltyAllocationRequests,
} from "./royalty-allocations"
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
      royalty_allocation_fingerprint TEXT
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
      position INTEGER NOT NULL CHECK (position >= 0),
      allocation_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  await client.execute(`CREATE UNIQUE INDEX idx_alloc_asset_wallet ON initial_royalty_allocations(asset_id, wallet_address_normalized)`)
  await client.execute(`CREATE UNIQUE INDEX idx_alloc_one_creator ON initial_royalty_allocations(asset_id) WHERE recipient_kind = 'creator'`)
  await client.execute(`CREATE UNIQUE INDEX idx_alloc_position ON initial_royalty_allocations(asset_id, position)`)
}

const assetInsertFor = (assetId: string, fingerprint: string): InStatement => ({
  sql: `INSERT INTO assets (asset_id, community_id, royalty_allocation_status, royalty_allocation_version, royalty_allocation_fingerprint) VALUES (?1, ?2, 'draft', ?3, ?4)`,
  args: [assetId, "com_1", ROYALTY_ALLOCATION_VERSION, fingerprint],
})

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
  const snapshot = { walletAddressNormalized: CREATOR, walletAddressDisplay: CREATOR, walletAttachmentId: "wa_1" }

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
  const snapshot = { walletAddressNormalized: CREATOR, walletAddressDisplay: CREATOR, walletAttachmentId: "wa_1" }
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

describe("resolveRoyaltyAllocationRequests", () => {
  const snapshot = { walletAddressNormalized: CREATOR, walletAddressDisplay: CREATOR, walletAttachmentId: "wa_1" }

  test("synthesizes the default creator split when the client omits allocations", () => {
    expect(resolveRoyaltyAllocationRequests({
      requestedAllocations: null,
      creator: snapshot,
    })).toEqual([
      {
        recipient_kind: "creator",
        wallet_address: CREATOR,
        share_bps: 10_000,
      },
    ])
  })

  test("preserves explicit allocation requests", () => {
    const allocations = split()
    expect(resolveRoyaltyAllocationRequests({
      requestedAllocations: allocations,
      creator: snapshot,
    })).toBe(allocations)
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
