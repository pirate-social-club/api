import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createClient } from "@libsql/client"
import { resolveCoreRepoPath } from "../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import {
  MOCK_BASE_SEPOLIA_PREFIX,
  createTonTestnetAcquisitionResolver,
  expectedTonPayload,
  isMockBaseSepoliaTxRef,
  mapTonTestnetTxToAcquisition,
  type TonTestnetClient,
  type TonTestnetTx,
} from "../src/lib/communities/commerce/funding-source/ton-testnet-resolver"
import { confirmTonTestnetFunding } from "../src/lib/communities/commerce/funding-source/ton-testnet-confirm"
import { getSpendIntent } from "../src/lib/communities/commerce/funding-source/spend-intent"
import type { FundingSourceAcquireInput } from "../src/lib/communities/commerce/funding-source/types"

const NOW = "2026-04-21T00:05:00.000Z"
const RESERVATION_FUTURE = "2026-04-21T01:00:00.000Z"
const SPI = "spi_ton1"
const RECIPIENT = "EQrecipient_test"
const ACQUIRE: FundingSourceAcquireInput = { provider: "ton_testnet_transfer", sourceTxRef: "ton-hash-1" }

function matchingTx(): TonTestnetTx {
  return { hash: "ton-hash-1", toAddress: RECIPIENT, amountNano: "1000000000", payload: expectedTonPayload(SPI) }
}

const EXPECT = { spendIntentId: SPI, expectedRecipient: RECIPIENT, minAmountNano: "1000000000" }

describe("ton testnet tx -> acquisition mapping", () => {
  test("a matching tx maps to confirmed with a NAMESPACED mock Base-Sepolia ref", () => {
    const result = mapTonTestnetTxToAcquisition(matchingTx(), ACQUIRE, EXPECT)
    expect(result.status).toBe("confirmed")
    if (result.status !== "confirmed") throw new Error("unreachable")
    expect(result.baseUsdcTxRef).toBe(`${MOCK_BASE_SEPOLIA_PREFIX}ton-hash-1`)
    expect(isMockBaseSepoliaTxRef(result.baseUsdcTxRef)).toBe(true)
    // Must NOT look like an EVM tx hash.
    expect(result.baseUsdcTxRef.startsWith("0x")).toBe(false)
    expect(result.sourceCorrelation.kind).toBe("ton_testnet")
  })

  test("no tx yet -> pending", () => {
    expect(mapTonTestnetTxToAcquisition(null, ACQUIRE, EXPECT).status).toBe("pending")
  })

  test("recipient mismatch -> failed + refundable", () => {
    const result = mapTonTestnetTxToAcquisition({ ...matchingTx(), toAddress: "EQsomeone_else" }, ACQUIRE, EXPECT)
    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("unreachable")
    expect(result.refundable).toBe(true)
    expect(result.reason).toMatch(/recipient/i)
  })

  test("payload not referencing the intent -> failed", () => {
    const result = mapTonTestnetTxToAcquisition({ ...matchingTx(), payload: "unrelated note" }, ACQUIRE, EXPECT)
    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("unreachable")
    expect(result.reason).toMatch(/payload/i)
  })

  test("a LOOSE payload that merely contains the intent id is rejected (exact match required)", () => {
    // Contains the spend intent id but is not the exact canonical memo.
    for (const payload of [`pay ${SPI}`, `${expectedTonPayload(SPI)} extra`, `x ${expectedTonPayload(SPI)}`]) {
      const result = mapTonTestnetTxToAcquisition({ ...matchingTx(), payload }, ACQUIRE, EXPECT)
      expect(result.status).toBe("failed")
    }
  })

  test("amount too low -> failed", () => {
    const result = mapTonTestnetTxToAcquisition({ ...matchingTx(), amountNano: "1" }, ACQUIRE, EXPECT)
    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("unreachable")
    expect(result.reason).toMatch(/amount/i)
  })

  test("resolver looks up the tx by sourceTxRef and rejects a missing hash", async () => {
    const seen: string[] = []
    const client: TonTestnetClient = {
      getTransaction: async (h) => {
        seen.push(h)
        return matchingTx()
      },
    }
    const resolver = createTonTestnetAcquisitionResolver({ client, expectations: EXPECT })
    const result = await resolver(ACQUIRE)
    expect(seen).toEqual(["ton-hash-1"])
    expect(result.status).toBe("confirmed")
    await expect(resolver({ provider: "ton_testnet_transfer" })).rejects.toThrow(/TON tx hash/i)
  })
})

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

async function insertTonIntent(
  client: ReturnType<typeof createClient>,
  opts?: { provider?: string; status?: string; spendIntentId?: string },
) {
  const id = opts?.spendIntentId ?? SPI
  await client.execute({
    sql: `
      INSERT INTO spend_intents (
        spend_intent_id, telegram_user_id, community_id, funding_source_provider,
        price_reservation_expires_at, status, idempotency_key, created_at, updated_at
      ) VALUES (?1, 'tg_1', 'cmt_1', ?2, ?3, ?4, ?5, '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z')
    `,
    args: [
      id,
      opts?.provider ?? "ton_testnet_transfer",
      RESERVATION_FUTURE,
      opts?.status ?? "funding_pending",
      `idem:${id}`,
    ],
  })
}

const tonClientReturning = (tx: TonTestnetTx | null): { tonClient: TonTestnetClient } => ({
  tonClient: { getTransaction: async () => tx },
})

describe("confirmTonTestnetFunding (dev acquire -> confirm loop)", () => {
  test("a verified TON transfer drives the intent to funding_confirmed with the mock ref bound", async () => {
    const cp = await createCpClient()
    try {
      await insertTonIntent(cp)
      const intent = await confirmTonTestnetFunding(
        { controlPlaneClient: cp, spendIntentId: SPI, tonTxHash: "ton-hash-1", expectedRecipient: RECIPIENT, minAmountNano: "1000000000", now: NOW },
        tonClientReturning(matchingTx()),
      )
      expect(intent.status).toBe("funding_confirmed")
      expect(intent.funding_receipt_tx_ref).toBe(`${MOCK_BASE_SEPOLIA_PREFIX}ton-hash-1`)
      expect(intent.funding_source_tx_ref).toBe("ton-hash-1")
    } finally {
      cp.close()
    }
  })

  test("tx not observed yet -> stays funding_pending (no binding)", async () => {
    const cp = await createCpClient()
    try {
      await insertTonIntent(cp)
      const intent = await confirmTonTestnetFunding(
        { controlPlaneClient: cp, spendIntentId: SPI, tonTxHash: "ton-hash-1", expectedRecipient: RECIPIENT, now: NOW },
        tonClientReturning(null),
      )
      expect(intent.status).toBe("funding_pending")
      expect(intent.funding_receipt_tx_ref).toBeNull()
    } finally {
      cp.close()
    }
  })

  test("a mismatched TON transfer -> refundable, nothing bound", async () => {
    const cp = await createCpClient()
    try {
      await insertTonIntent(cp)
      const intent = await confirmTonTestnetFunding(
        { controlPlaneClient: cp, spendIntentId: SPI, tonTxHash: "ton-hash-1", expectedRecipient: RECIPIENT, now: NOW },
        tonClientReturning({ ...matchingTx(), toAddress: "EQwrong" }),
      )
      expect(intent.status).toBe("refundable")
      expect(intent.funding_receipt_tx_ref).toBeNull()
    } finally {
      cp.close()
    }
  })

  test("rejects a non-ton_testnet intent", async () => {
    const cp = await createCpClient()
    try {
      await insertTonIntent(cp, { provider: "pirate_checkout" })
      await expect(
        confirmTonTestnetFunding(
          { controlPlaneClient: cp, spendIntentId: SPI, tonTxHash: "ton-hash-1", expectedRecipient: RECIPIENT, now: NOW },
          tonClientReturning(matchingTx()),
        ),
      ).rejects.toThrow(/not a ton_testnet_transfer intent/i)
    } finally {
      cp.close()
    }
  })

  test("rejects an intent not in a fundable state", async () => {
    const cp = await createCpClient()
    try {
      await insertTonIntent(cp, { status: "proposed" })
      await expect(
        confirmTonTestnetFunding(
          { controlPlaneClient: cp, spendIntentId: SPI, tonTxHash: "ton-hash-1", expectedRecipient: RECIPIENT, now: NOW },
          tonClientReturning(matchingTx()),
        ),
      ).rejects.toThrow(/not in a fundable state/i)
    } finally {
      cp.close()
    }
  })

  test("authorize rejection aborts before any state change", async () => {
    const cp = await createCpClient()
    try {
      await insertTonIntent(cp)
      await expect(
        confirmTonTestnetFunding(
          {
            controlPlaneClient: cp,
            spendIntentId: SPI,
            tonTxHash: "ton-hash-1",
            expectedRecipient: RECIPIENT,
            now: NOW,
            authorize: () => {
              throw new Error("not the owner")
            },
          },
          tonClientReturning(matchingTx()),
        ),
      ).rejects.toThrow(/not the owner/i)
      const intent = await getSpendIntent({ client: cp, spendIntentId: SPI })
      expect(intent?.status).toBe("funding_pending")
    } finally {
      cp.close()
    }
  })
})
