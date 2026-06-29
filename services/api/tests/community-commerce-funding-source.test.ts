import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createClient } from "@libsql/client"
import { resolveCoreRepoPath } from "../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import {
  acquireFunding,
  setOmnistonAcquisitionResolverForTests,
} from "../src/lib/communities/commerce/funding-source/acquisition"
import {
  advanceSpendIntentFunding,
  getSpendIntent,
  recordFundingAcquisition,
} from "../src/lib/communities/commerce/funding-source/spend-intent"
import type { FundingAcquisition } from "../src/lib/communities/commerce/funding-source/types"

afterEach(() => {
  setOmnistonAcquisitionResolverForTests(null)
})

const RESERVATION_EXPIRES = "2026-04-21T00:10:00.000Z"
const NOW_BEFORE_EXPIRY = "2026-04-21T00:05:00.000Z"
const NOW_AFTER_EXPIRY = "2026-04-21T00:15:00.000Z"

// Build the schema from the REAL control-plane migration (0119, in the core repo, resolved via
// PIRATE_CORE_REPO) through the same Postgres->SQLite shim the control-plane test harness uses,
// so this suite proves the shipped migration itself — not a hand-kept copy. The communities FK
// target is absent here; SQLite leaves foreign_keys OFF, so inserts aren't FK-checked, but the
// UNIQUE/CHECK constraints the state machine relies on are exercised exactly as shipped.
const SPEND_INTENTS_MIGRATION = readFileSync(
  resolveCoreRepoPath("db/control-plane/migrations/0119_control_plane_spend_intents.sql"),
  "utf8",
)

async function createSpendIntentClient() {
  const client = createClient({ url: ":memory:" })
  await client.execute("PRAGMA foreign_keys = OFF")
  for (const statement of splitSqlStatements(SPEND_INTENTS_MIGRATION)) {
    for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
      await client.execute(sqliteStatement)
    }
  }
  return client
}

async function insertFundingPendingIntent(
  client: ReturnType<typeof createClient>,
  overrides: { spendIntentId: string; provider?: string; reservationExpiresAt?: string },
) {
  // Conversation-first: telegram_user_id is required up front; community/asset/quote stay null
  // until resolution. Provider + reservation are set once the priced confirmation is shown.
  await client.execute({
    sql: `
      INSERT INTO spend_intents (
        spend_intent_id, telegram_user_id, funding_source_provider,
        price_reservation_expires_at, status, idempotency_key, created_at, updated_at
      ) VALUES (
        ?1, 'tg_1', ?2, ?3, 'funding_pending', ?4,
        '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z'
      )
    `,
    args: [
      overrides.spendIntentId,
      overrides.provider ?? "omniston_ton",
      overrides.reservationExpiresAt ?? RESERVATION_EXPIRES,
      `idem:${overrides.spendIntentId}`,
    ],
  })
}

const confirmedFromTon = (baseUsdcTxRef: string, tonTxRef: string): FundingAcquisition => ({
  status: "confirmed",
  baseUsdcTxRef,
  sourceCorrelation: {
    kind: "omniston_ton",
    sourceTxRef: tonTxRef,
    routeRef: `route:${tonTxRef}`,
    baseUsdcTxRef,
  },
})

describe("funding source acquisition boundary", () => {
  // Boundary 5: pirate_checkout pays no abstraction tax.
  test("pirate_checkout acquisition is a thin adapter: funding_tx_ref becomes baseUsdcTxRef", async () => {
    const result = await acquireFunding({
      provider: "pirate_checkout",
      fundingTxRef: "0xBASEpirate",
    })
    expect(result.status).toBe("confirmed")
    if (result.status !== "confirmed") throw new Error("unreachable")
    expect(result.baseUsdcTxRef).toBe("0xBASEpirate")
    expect(result.sourceCorrelation.kind).toBe("evm_direct")
  })

  // Boundary 2: acquireFunding returns acquisition state only — never a trusted receipt.
  test("confirmed acquisition exposes baseUsdcTxRef and no BuyerFundingReceipt", async () => {
    setOmnistonAcquisitionResolverForTests(async () =>
      confirmedFromTon("0xBASEton", "ton:msg:1"),
    )
    const result = await acquireFunding({ provider: "omniston_ton", sourceTxRef: "ton:msg:1" })
    expect(result.status).toBe("confirmed")
    if (result.status !== "confirmed") throw new Error("unreachable")
    expect(result.baseUsdcTxRef).toBe("0xBASEton")
    // The acquisition must not carry receipt fields (token/amount/recipient): those come only
    // from on-chain verification of baseUsdcTxRef downstream.
    expect("receipt" in result).toBe(false)
    expect("amountAtomic" in result).toBe(false)
    expect("tokenAddress" in result).toBe(false)
  })
})

describe("spend intent funding state machine", () => {
  // Boundary 1: the terminal boundary receives the Base USDC tx, never the TON tx.
  test("settlement is invoked with the Base USDC tx ref, not the originating TON tx", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, { spendIntentId: "spi_1" })
      setOmnistonAcquisitionResolverForTests(async () =>
        confirmedFromTon("0xBASEsettle", "ton:msg:settle"),
      )

      const settledWith: string[] = []
      const intent = await advanceSpendIntentFunding({
        client,
        spendIntentId: "spi_1",
        acquireInput: { provider: "omniston_ton", sourceTxRef: "ton:msg:settle" },
        now: NOW_BEFORE_EXPIRY,
        settle: async (baseUsdcTxRef) => {
          settledWith.push(baseUsdcTxRef)
        },
      })

      expect(settledWith).toEqual(["0xBASEsettle"])
      expect(settledWith).not.toContain("ton:msg:settle")
      // Terminal for the funding bridge is funding_confirmed, NOT settled (purchase not complete).
      expect(intent.status).toBe("funding_confirmed")
      // Correlation to the TON leg + Omniston route is retained separately for audit/refund.
      expect(intent.funding_source_tx_ref).toBe("ton:msg:settle")
      expect(intent.funding_route_ref).toBe("route:ton:msg:settle")
      expect(intent.funding_receipt_tx_ref).toBe("0xBASEsettle")
    } finally {
      client.close()
    }
  })

  // Boundary 3: late-receipt behavior belongs to the state machine.
  test("receipt before reservation expiry transitions to funded", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, { spendIntentId: "spi_funded" })
      const intent = await recordFundingAcquisition({
        client,
        spendIntentId: "spi_funded",
        acquisition: confirmedFromTon("0xBASEa", "ton:a"),
        now: NOW_BEFORE_EXPIRY,
      })
      expect(intent.status).toBe("funded")
      expect(intent.funding_receipt_tx_ref).toBe("0xBASEa")
    } finally {
      client.close()
    }
  })

  test("receipt after reservation expiry transitions to refundable", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, { spendIntentId: "spi_late" })
      const intent = await recordFundingAcquisition({
        client,
        spendIntentId: "spi_late",
        acquisition: confirmedFromTon("0xBASElate", "ton:late"),
        now: NOW_AFTER_EXPIRY,
      })
      expect(intent.status).toBe("refundable")
      // The receipt is still bound (funds did arrive) — it just routes to refund, not settle.
      expect(intent.funding_receipt_tx_ref).toBe("0xBASElate")
    } finally {
      client.close()
    }
  })

  // Finding #1: expiry is compared by epoch ms, robust to timestamp serialization differences.
  // A Postgres-style TIMESTAMPTZ ("YYYY-MM-DD HH:MM:SS+00") would sort AFTER an ISO `now` under
  // lexicographic comparison (' ' < 'T'), wrongly flagging an unexpired reservation as expired.
  test("reservation expiry is robust to timestamp format (not lexicographic)", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, {
        spendIntentId: "spi_fmt",
        reservationExpiresAt: "2026-04-21 00:10:00+00", // Postgres timestamptz text form
      })
      const intent = await recordFundingAcquisition({
        client,
        spendIntentId: "spi_fmt",
        acquisition: confirmedFromTon("0xBASEfmt", "ton:fmt"),
        now: NOW_BEFORE_EXPIRY, // 00:05 ISO — genuinely before 00:10, must be funded
      })
      expect(intent.status).toBe("funded")
    } finally {
      client.close()
    }
  })

  test("an unparseable reservation timestamp is rejected, not silently mis-bucketed", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, {
        spendIntentId: "spi_badts",
        reservationExpiresAt: "not-a-timestamp",
      })
      await expect(
        recordFundingAcquisition({
          client,
          spendIntentId: "spi_badts",
          acquisition: confirmedFromTon("0xBASEbadts", "ton:badts"),
          now: NOW_BEFORE_EXPIRY,
        }),
      ).rejects.toThrow(/unparseable timestamp/i)
    } finally {
      client.close()
    }
  })

  // Finding #3: only a unique violation maps to a conflict; other DB errors must propagate.
  test("a non-unique DB error during binding propagates, not masked as a duplicate receipt", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, { spendIntentId: "spi_dberr" })
      // Wrap the client so the receipt-binding UPDATE throws a generic (non-unique) DB error.
      const failingClient = {
        execute: (stmt: { sql: string; args?: unknown[] } | string) => {
          const sql = typeof stmt === "string" ? stmt : stmt.sql
          if (sql.includes("funding_receipt_tx_ref = ?2")) {
            throw new Error("SQLITE_ERROR: disk I/O error")
          }
          return client.execute(stmt as never)
        },
      }
      await expect(
        recordFundingAcquisition({
          client: failingClient as never,
          spendIntentId: "spi_dberr",
          acquisition: confirmedFromTon("0xBASEdberr", "ton:dberr"),
          now: NOW_BEFORE_EXPIRY,
        }),
      ).rejects.toThrow(/disk i\/o error/i)
    } finally {
      client.close()
    }
  })

  test("no receipt yet keeps the intent funding_pending", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, { spendIntentId: "spi_pending" })
      const intent = await recordFundingAcquisition({
        client,
        spendIntentId: "spi_pending",
        acquisition: {
          status: "pending",
          sourceCorrelation: { kind: "omniston_ton", routeRef: "route:p", sourceTxRef: "ton:p" },
        },
        now: NOW_BEFORE_EXPIRY,
      })
      expect(intent.status).toBe("funding_pending")
      expect(intent.funding_receipt_tx_ref).toBeNull()
      expect(intent.funding_source_tx_ref).toBe("ton:p")
      // routeRef is a durable handle even when no TON tx exists yet.
      expect(intent.funding_route_ref).toBe("route:p")
    } finally {
      client.close()
    }
  })

  // Boundary 4: exactly-once is enforced before settlement.
  test("repeated poll with the same Base tx ref is idempotent", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, { spendIntentId: "spi_idem" })
      const first = await recordFundingAcquisition({
        client,
        spendIntentId: "spi_idem",
        acquisition: confirmedFromTon("0xBASEsame", "ton:same"),
        now: NOW_BEFORE_EXPIRY,
      })
      const second = await recordFundingAcquisition({
        client,
        spendIntentId: "spi_idem",
        acquisition: confirmedFromTon("0xBASEsame", "ton:same"),
        now: NOW_BEFORE_EXPIRY,
      })
      expect(first.status).toBe("funded")
      expect(second.status).toBe("funded")
      expect(second.funding_receipt_tx_ref).toBe("0xBASEsame")
    } finally {
      client.close()
    }
  })

  test("a second different Base tx ref for the same intent is rejected", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, { spendIntentId: "spi_diff" })
      await recordFundingAcquisition({
        client,
        spendIntentId: "spi_diff",
        acquisition: confirmedFromTon("0xBASEfirst", "ton:1"),
        now: NOW_BEFORE_EXPIRY,
      })
      await expect(
        recordFundingAcquisition({
          client,
          spendIntentId: "spi_diff",
          acquisition: confirmedFromTon("0xBASEsecond", "ton:2"),
          now: NOW_BEFORE_EXPIRY,
        }),
      ).rejects.toThrow(/already bound to a different funding receipt/i)
    } finally {
      client.close()
    }
  })

  // Finding #2: provider mismatch is rejected and binds nothing.
  test("advancing with a provider that does not match the intent is rejected", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, { spendIntentId: "spi_mismatch", provider: "omniston_ton" })
      // pirate_checkout acquisition would otherwise confirm immediately — guard must fire first.
      await expect(
        advanceSpendIntentFunding({
          client,
          spendIntentId: "spi_mismatch",
          acquireInput: { provider: "pirate_checkout", fundingTxRef: "0xBASEwrong" },
          now: NOW_BEFORE_EXPIRY,
          settle: async () => {
            throw new Error("settle must not run on a mismatched provider")
          },
        }),
      ).rejects.toThrow(/provider does not match/i)

      const intent = await getSpendIntent({ client, spendIntentId: "spi_mismatch" })
      expect(intent?.status).toBe("funding_pending")
      expect(intent?.funding_receipt_tx_ref).toBeNull()
    } finally {
      client.close()
    }
  })

  // Finding #3: failed acquisitions still persist source correlation for refund/audit.
  test("a failed acquisition retains the source correlation breadcrumb", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, { spendIntentId: "spi_fail" })
      const intent = await recordFundingAcquisition({
        client,
        spendIntentId: "spi_fail",
        acquisition: {
          status: "failed",
          reason: "omniston route reverted",
          refundable: true,
          sourceCorrelation: { kind: "omniston_ton", routeRef: "route:reverted", sourceTxRef: "ton:reverted" },
        },
        now: NOW_BEFORE_EXPIRY,
      })
      expect(intent.status).toBe("refundable")
      expect(intent.failure_reason).toBe("omniston route reverted")
      expect(intent.funding_source_tx_ref).toBe("ton:reverted")
      // Durable route handle survives failure — this is when reconciliation needs it most.
      expect(intent.funding_route_ref).toBe("route:reverted")
      expect(intent.funding_receipt_tx_ref).toBeNull()
    } finally {
      client.close()
    }
  })

  // Finding #4: settlement failure reverts to funded (retryable), never stuck in settling.
  test("settlement failure reverts the intent to funded with a reason, not stuck settling", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, { spendIntentId: "spi_settlefail" })
      setOmnistonAcquisitionResolverForTests(async () =>
        confirmedFromTon("0xBASEsf", "ton:sf"),
      )
      await expect(
        advanceSpendIntentFunding({
          client,
          spendIntentId: "spi_settlefail",
          acquireInput: { provider: "omniston_ton", sourceTxRef: "ton:sf" },
          now: NOW_BEFORE_EXPIRY,
          settle: async () => {
            throw new Error("story settlement timed out")
          },
        }),
      ).rejects.toThrow(/story settlement timed out/i)

      const intent = await getSpendIntent({ client, spendIntentId: "spi_settlefail" })
      expect(intent?.status).toBe("funded")
      expect(intent?.failure_reason).toBe("story settlement timed out")
      // Receipt stays bound so the reconciler's retry remains exactly-once.
      expect(intent?.funding_receipt_tx_ref).toBe("0xBASEsf")
    } finally {
      client.close()
    }
  })

  test("the same Base tx ref cannot be bound to two intents", async () => {
    const client = await createSpendIntentClient()
    try {
      await insertFundingPendingIntent(client, { spendIntentId: "spi_a" })
      await insertFundingPendingIntent(client, { spendIntentId: "spi_b" })
      await recordFundingAcquisition({
        client,
        spendIntentId: "spi_a",
        acquisition: confirmedFromTon("0xBASEshared", "ton:a"),
        now: NOW_BEFORE_EXPIRY,
      })
      await expect(
        recordFundingAcquisition({
          client,
          spendIntentId: "spi_b",
          acquisition: confirmedFromTon("0xBASEshared", "ton:b"),
          now: NOW_BEFORE_EXPIRY,
        }),
      ).rejects.toThrow(/already bound to another spend intent/i)
    } finally {
      client.close()
    }
  })
})
