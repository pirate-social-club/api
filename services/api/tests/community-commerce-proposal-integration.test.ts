import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createClient } from "@libsql/client"
import { resolveCoreRepoPath } from "../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import { buildPurchaseProposalDeps, type PurchaseProposalLowLevelDeps } from "../src/lib/communities/commerce/funding-source/purchase-proposal-deps"
import { proposeSongPurchase } from "../src/lib/communities/commerce/funding-source/purchase-proposal"

const NOW = "2026-04-21T00:05:00.000Z"
const BUYER = "0x1111111111111111111111111111111111111111"
const PUBLIC_LISTING = "lst_abc" // what the LLM passes
const RAW_LISTING = "abc" // the listing_id stored in the DB / on the intent

const MIGRATION = readFileSync(
  resolveCoreRepoPath("db/control-plane/migrations/0119_control_plane_spend_intents.sql"),
  "utf8",
)

async function createCpClient() {
  const client = createClient({ url: ":memory:" })
  await client.execute("PRAGMA foreign_keys = OFF")
  for (const statement of splitSqlStatements(MIGRATION)) {
    for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
      await client.execute(sqliteStatement)
    }
  }
  return client
}

// External services faked at their lowest boundary; the assembly + orchestration + the real
// control-plane proposed-intent write run for real.
function lowLevel(overrides?: { walletRows?: Array<{ chain_namespace: string; wallet_address_display: string; is_primary: number }> }): PurchaseProposalLowLevelDeps {
  return {
    openCommunityDb: async () => ({ client: {} as never, close: () => {} }),
    getListingRowById: async (_client, _communityId, listingId) =>
      listingId === PUBLIC_LISTING
        ? { listing_id: RAW_LISTING, asset_id: "ast_abc", price_usd: 3, status: "active" }
        : null,
    getAssetDisplayTitle: async () => "Concrete Jungle",
    listActiveWalletAttachmentRows: async () =>
      overrides?.walletRows ?? [{ chain_namespace: "eip155", wallet_address_display: BUYER, is_primary: 1 }],
    createPublicCommunityPurchaseQuote: (async () => ({
      id: "pq_quo1",
      community: "com_cmt1",
      listing: `lst_${RAW_LISTING}`,
      asset: "asset_ast_abc",
      final_price_cents: 300,
      funding_mode: "routed",
      route_provider: "pirate_checkout",
      buyer_kind: "wallet",
      buyer_wallet: { chain_ref: "eip155", address: BUYER },
      expires_at: 1776556800,
    })) as unknown as PurchaseProposalLowLevelDeps["createPublicCommunityPurchaseQuote"],
  }
}

const ctx = (controlPlaneClient: ReturnType<typeof createClient>) => ({
  env: {} as never,
  controlPlaneClient,
  communityRepository: {} as never,
  userRepository: {} as never,
  now: NOW,
})

async function intentCount(cp: ReturnType<typeof createClient>) {
  const rows = await cp.execute("SELECT COUNT(*) AS n FROM spend_intents")
  return Number((rows.rows[0] as unknown as { n: number }).n)
}

const proposeInput = (reference: { kind: "listing_id"; listingId: string } | { kind: "query"; query: string }) => ({
  env: {} as never,
  telegramUserId: "tg_1",
  userId: "usr_1",
  communityId: "cmt1",
  reference,
})

describe("purchase proposal — assembled real dependency graph", () => {
  test("an exact listing_id creates EXACTLY ONE proposed intent in control-plane", async () => {
    const cp = await createCpClient()
    try {
      const deps = buildPurchaseProposalDeps(ctx(cp), lowLevel())
      const result = await proposeSongPurchase(proposeInput({ kind: "listing_id", listingId: PUBLIC_LISTING }), deps)

      expect(result.outcome).toBe("proposed")
      if (result.outcome !== "proposed") throw new Error("unreachable")
      expect(result.title).toBe("Concrete Jungle")
      expect(result.priceUsd).toBe(3)
      expect(await intentCount(cp)).toBe(1)

      const row = await cp.execute("SELECT status, quote_id, listing_id, asset_id, buyer_address, telegram_user_id, user_id FROM spend_intents")
      expect(row.rows[0]).toMatchObject({
        status: "proposed",
        quote_id: "quo1",
        listing_id: RAW_LISTING,
        asset_id: "ast_abc",
        buyer_address: BUYER,
        telegram_user_id: "tg_1",
        user_id: "usr_1",
      })
    } finally {
      cp.close()
    }
  })

  test("a query-only reference resolves to not_found and creates NOTHING", async () => {
    const cp = await createCpClient()
    try {
      const deps = buildPurchaseProposalDeps(ctx(cp), lowLevel())
      const result = await proposeSongPurchase(proposeInput({ kind: "query", query: "reggae" }), deps)
      expect(result.outcome).toBe("not_found")
      expect(await intentCount(cp)).toBe(0)
    } finally {
      cp.close()
    }
  })

  test("fails closed when the user has no EVM wallet — creates NOTHING", async () => {
    const cp = await createCpClient()
    try {
      const deps = buildPurchaseProposalDeps(ctx(cp), lowLevel({ walletRows: [] }))
      await expect(
        proposeSongPurchase(proposeInput({ kind: "listing_id", listingId: PUBLIC_LISTING }), deps),
      ).rejects.toThrow(/connected wallet is required/i)
      expect(await intentCount(cp)).toBe(0)
    } finally {
      cp.close()
    }
  })

  test("an unknown listing_id resolves to not_found and creates nothing", async () => {
    const cp = await createCpClient()
    try {
      const deps = buildPurchaseProposalDeps(ctx(cp), lowLevel())
      const result = await proposeSongPurchase(proposeInput({ kind: "listing_id", listingId: "lst_missing" }), deps)
      expect(result.outcome).toBe("not_found")
      expect(await intentCount(cp)).toBe(0)
    } finally {
      cp.close()
    }
  })
})
