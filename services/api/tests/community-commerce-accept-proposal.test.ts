import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createClient } from "@libsql/client"
import { resolveCoreRepoPath } from "../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import {
  acceptSpendIntentProposal,
  handleAcceptProposal,
  selectFundingProvider,
  type AcceptProposalRouteDeps,
  type PaymentInstructions,
} from "../src/lib/communities/commerce/funding-source/accept-proposal"
import { getSpendIntent } from "../src/lib/communities/commerce/funding-source/spend-intent"

const NOW = "2026-04-21T00:05:00.000Z"
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

async function insertIntent(
  client: ReturnType<typeof createClient>,
  opts: { spendIntentId: string; status?: string; community?: string },
) {
  await client.execute({
    sql: `
      INSERT INTO spend_intents (
        spend_intent_id, telegram_user_id, community_id, status, idempotency_key, created_at, updated_at
      ) VALUES (?1, 'tg_1', ?2, ?3, ?4, '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z')
    `,
    args: [opts.spendIntentId, opts.community ?? "cmt_1", opts.status ?? "proposed", `idem:${opts.spendIntentId}`],
  })
}

const PC_INSTRUCTIONS: PaymentInstructions = {
  provider: "pirate_checkout",
  kind: "evm_usdc",
  chainId: 84532,
  tokenSymbol: "USDC",
  toAddress: "0xoperator",
  amountUsd: 3,
  note: "Send USDC on Base Sepolia",
}

const buildPaymentInstructions = async ({ provider }: { provider: "pirate_checkout" | "ton_testnet_transfer" }): Promise<PaymentInstructions> =>
  provider === "pirate_checkout"
    ? PC_INSTRUCTIONS
    : {
        provider: "ton_testnet_transfer",
        kind: "ton_testnet",
        toAddress: "EQtestrecipient",
        amountTon: "1.0",
        comment: "pirate-spend:spi_x",
        testSimulation: true,
        note: "Approve the TON testnet transfer (test funding simulation)",
      }

describe("funding provider selection (gating)", () => {
  test("pirate_checkout is always selectable", () => {
    expect(selectFundingProvider("pirate_checkout", { tonTestnetEnabled: false })).toBe("pirate_checkout")
  })
  test("ton_testnet_transfer only when explicitly enabled", () => {
    expect(selectFundingProvider("ton_testnet_transfer", { tonTestnetEnabled: true })).toBe("ton_testnet_transfer")
    expect(() => selectFundingProvider("ton_testnet_transfer", { tonTestnetEnabled: false })).toThrow(/not available/i)
  })
  test("omniston_ton is not yet selectable", () => {
    expect(() => selectFundingProvider("omniston_ton", { tonTestnetEnabled: true })).toThrow(/not yet available/i)
  })
  test("unknown providers are rejected", () => {
    expect(() => selectFundingProvider("paypal", { tonTestnetEnabled: true })).toThrow(/unknown funding provider/i)
  })
})

describe("acceptSpendIntentProposal (proposed -> funding_pending)", () => {
  test("transitions a proposal to funding_pending, records provider, returns instructions", async () => {
    const cp = await createCpClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_accept" })
      const result = await acceptSpendIntentProposal(
        { controlPlaneClient: cp, spendIntentId: "spi_accept", provider: "pirate_checkout", now: NOW },
        { buildPaymentInstructions },
      )

      expect(result.status).toBe("funding_pending")
      expect(result.provider).toBe("pirate_checkout")
      expect(result.paymentInstructions).toEqual(PC_INSTRUCTIONS)
      expect(result.purchaseComplete).toBe(false)
      expect(result.fundsMoved).toBe(false)

      const intent = await getSpendIntent({ client: cp, spendIntentId: "spi_accept" })
      expect(intent?.status).toBe("funding_pending")
      expect(intent?.funding_source_provider).toBe("pirate_checkout")
    } finally {
      cp.close()
    }
  })

  test("ton_testnet_transfer returns test-labelled instructions and stays purchaseComplete:false", async () => {
    const cp = await createCpClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_ton" })
      const result = await acceptSpendIntentProposal(
        { controlPlaneClient: cp, spendIntentId: "spi_ton", provider: "ton_testnet_transfer", now: NOW },
        { buildPaymentInstructions },
      )
      expect(result.provider).toBe("ton_testnet_transfer")
      if (result.paymentInstructions.provider !== "ton_testnet_transfer") throw new Error("unreachable")
      expect(result.paymentInstructions.testSimulation).toBe(true)
      expect(result.purchaseComplete).toBe(false)
    } finally {
      cp.close()
    }
  })

  test("rejects accepting from a non-proposal state (no re-entry)", async () => {
    const cp = await createCpClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_bad", status: "funding_pending" })
      await expect(
        acceptSpendIntentProposal(
          { controlPlaneClient: cp, spendIntentId: "spi_bad", provider: "pirate_checkout", now: NOW },
          { buildPaymentInstructions },
        ),
      ).rejects.toThrow(/cannot begin funding/i)
    } finally {
      cp.close()
    }
  })

  test("authorize rejection leaves the intent untouched (still proposed)", async () => {
    const cp = await createCpClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_authz" })
      await expect(
        acceptSpendIntentProposal(
          {
            controlPlaneClient: cp,
            spendIntentId: "spi_authz",
            provider: "pirate_checkout",
            now: NOW,
            authorize: () => {
              throw new Error("not the owner")
            },
          },
          { buildPaymentInstructions },
        ),
      ).rejects.toThrow(/not the owner/i)
      const intent = await getSpendIntent({ client: cp, spendIntentId: "spi_authz" })
      expect(intent?.status).toBe("proposed")
      expect(intent?.funding_source_provider).toBeNull()
    } finally {
      cp.close()
    }
  })

  test("payment-instruction failure leaves the intent proposed", async () => {
    const cp = await createCpClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_unresolved" })
      await expect(
        acceptSpendIntentProposal(
          { controlPlaneClient: cp, spendIntentId: "spi_unresolved", provider: "pirate_checkout", now: NOW },
          {
            buildPaymentInstructions: async ({ intent }) => {
              if (!intent.quote_id) {
                throw new Error("Spend intent is not resolved (quote missing)")
              }
              return PC_INSTRUCTIONS
            },
          },
        ),
      ).rejects.toThrow(/quote missing/i)
      const intent = await getSpendIntent({ client: cp, spendIntentId: "spi_unresolved" })
      expect(intent?.status).toBe("proposed")
      expect(intent?.funding_source_provider).toBeNull()
    } finally {
      cp.close()
    }
  })
})

function makeRouteDeps(overrides?: {
  authedTelegramUserId?: string
  intentOwnerTelegramUserId?: string
  intentCommunityId?: string | null
  tonTestnetEnabled?: boolean
}) {
  const calls = { acceptProposal: 0 }
  const deps: AcceptProposalRouteDeps = {
    getCommunityRepository: () => ({}) as never,
    resolveCommunityId: async () => "cmt_1",
    verifyMiniAppUser: () => ({ id: overrides?.authedTelegramUserId ?? "tg_1" }),
    tonTestnetEnabled: overrides?.tonTestnetEnabled ?? false,
    acceptProposal: async (input) => {
      calls.acceptProposal += 1
      const intent = {
        spend_intent_id: input.spendIntentId,
        telegram_user_id: overrides?.intentOwnerTelegramUserId ?? "tg_1",
        community_id: overrides?.intentCommunityId === undefined ? "cmt_1" : overrides.intentCommunityId,
        status: "funding_pending",
      } as never
      await input.authorize?.(intent)
      return {
        spendIntentId: input.spendIntentId,
        status: "funding_pending",
        provider: input.provider,
        paymentInstructions: PC_INSTRUCTIONS,
        purchaseComplete: false,
        fundsMoved: false,
      }
    },
  }
  return { deps, calls }
}

const body = (extra?: Record<string, unknown>) => ({
  community_id: "my-community",
  init_data: "user=...&hash=...",
  spend_intent_id: "spi_1",
  provider: "pirate_checkout",
  ...extra,
})

describe("accept-proposal route handler", () => {
  test("owner + community -> funding_pending result", async () => {
    const { deps, calls } = makeRouteDeps()
    const result = await handleAcceptProposal({ env: {} as never, body: body(), now: NOW }, deps)
    expect(result.status).toBe("funding_pending")
    expect(result.purchaseComplete).toBe(false)
    expect(calls.acceptProposal).toBe(1)
  })

  test("non-owner -> not found", async () => {
    const { deps } = makeRouteDeps({ authedTelegramUserId: "tg_OTHER" })
    await expect(handleAcceptProposal({ env: {} as never, body: body(), now: NOW }, deps)).rejects.toThrow(/not found/i)
  })

  test("ton_testnet_transfer rejected when disabled, before any auth/DB work", async () => {
    const { deps, calls } = makeRouteDeps({ tonTestnetEnabled: false })
    await expect(
      handleAcceptProposal({ env: {} as never, body: body({ provider: "ton_testnet_transfer" }), now: NOW }, deps),
    ).rejects.toThrow(/not available/i)
    expect(calls.acceptProposal).toBe(0)
  })

  test("missing provider -> bad request", async () => {
    const { deps } = makeRouteDeps()
    await expect(
      handleAcceptProposal({ env: {} as never, body: body({ provider: "" }), now: NOW }, deps),
    ).rejects.toThrow(/required/i)
  })
})
