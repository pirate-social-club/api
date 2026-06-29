import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createClient } from "@libsql/client"
import { resolveCoreRepoPath } from "../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import {
  insertProposedSpendIntent,
  insertTelegramOnlyProposedSpendIntent,
} from "../src/lib/communities/commerce/funding-source/proposed-intent"
import { getSpendIntent } from "../src/lib/communities/commerce/funding-source/spend-intent"

const NOW = "2026-04-21T00:05:00.000Z"
const LISTING = { listingId: "lst_reggae", assetId: "ast_reggae", title: "Concrete Jungle", priceUsd: 3 }

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

const baseInput = (client: ReturnType<typeof createClient>) => ({
  client,
  telegramUserId: "tg_1",
  communityId: "cmt_1",
  listing: LISTING,
  buyerWalletAddress: "0xbuyer",
  quoteId: "quo_1",
  reservationExpiresAt: "2026-04-21T01:00:00.000Z",
  now: NOW,
})

describe("insertProposedSpendIntent (control-plane proposed intent)", () => {
  test("creates a proposed intent with the resolved binding and no provider yet", async () => {
    const cp = await createCpClient()
    try {
      const { spendIntentId } = await insertProposedSpendIntent(baseInput(cp))
      const intent = await getSpendIntent({ client: cp, spendIntentId })
      expect(intent?.status).toBe("proposed")
      expect(intent?.telegram_user_id).toBe("tg_1")
      expect(intent?.community_id).toBe("cmt_1")
      expect(intent?.quote_id).toBe("quo_1")
      expect(intent?.asset_id).toBe("ast_reggae")
      expect(intent?.buyer_address).toBe("0xbuyer")
      // Provider is chosen later at accept time.
      expect(intent?.funding_source_provider).toBeNull()
    } finally {
      cp.close()
    }
  })

  test("is idempotent on (telegram_user, quote): re-proposing returns the same intent", async () => {
    const cp = await createCpClient()
    try {
      const first = await insertProposedSpendIntent(baseInput(cp))
      const second = await insertProposedSpendIntent(baseInput(cp))
      expect(second.spendIntentId).toBe(first.spendIntentId)
      const rows = await cp.execute("SELECT COUNT(*) AS n FROM spend_intents")
      expect(Number((rows.rows[0] as unknown as { n: number }).n)).toBe(1)
    } finally {
      cp.close()
    }
  })

  test("different quotes create distinct intents", async () => {
    const cp = await createCpClient()
    try {
      const a = await insertProposedSpendIntent(baseInput(cp))
      const b = await insertProposedSpendIntent({ ...baseInput(cp), quoteId: "quo_2" })
      expect(b.spendIntentId).not.toBe(a.spendIntentId)
    } finally {
      cp.close()
    }
  })

  test("creates a Telegram-only pre-money intent without user, wallet, or quote", async () => {
    const cp = await createCpClient()
    try {
      const { spendIntentId } = await insertTelegramOnlyProposedSpendIntent({
        client: cp,
        telegramUserId: "tg_telegram_only",
        communityId: "cmt_1",
        listing: LISTING,
        reservationExpiresAt: "2026-04-21T01:00:00.000Z",
        idempotencyKey: "client-retry-1",
        now: NOW,
      })
      const intent = await getSpendIntent({ client: cp, spendIntentId })
      expect(intent?.status).toBe("proposed")
      expect(intent?.telegram_user_id).toBe("tg_telegram_only")
      expect(intent?.community_id).toBe("cmt_1")
      expect(intent?.asset_id).toBe("ast_reggae")
      expect(intent?.user_id).toBeNull()
      expect(intent?.buyer_address).toBeNull()
      expect(intent?.quote_id).toBeNull()
      expect(intent?.funding_source_provider).toBeNull()
    } finally {
      cp.close()
    }
  })

  test("Telegram-only proposal idempotency is scoped to the client idempotency key", async () => {
    const cp = await createCpClient()
    try {
      const input = {
        client: cp,
        telegramUserId: "tg_1",
        communityId: "cmt_1",
        listing: LISTING,
        reservationExpiresAt: "2026-04-21T01:00:00.000Z",
        now: NOW,
      }
      const first = await insertTelegramOnlyProposedSpendIntent({ ...input, idempotencyKey: "retry-a" })
      const second = await insertTelegramOnlyProposedSpendIntent({ ...input, idempotencyKey: "retry-a" })
      const third = await insertTelegramOnlyProposedSpendIntent({ ...input, idempotencyKey: "retry-b" })
      expect(second.spendIntentId).toBe(first.spendIntentId)
      expect(third.spendIntentId).not.toBe(first.spendIntentId)
    } finally {
      cp.close()
    }
  })
})
