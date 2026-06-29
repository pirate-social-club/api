import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createClient } from "@libsql/client"
import { resolveCoreRepoPath } from "../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import {
  assertQuoteSettleableForSpendIntent,
  settlePirateCheckoutSpendIntent,
  type SettleSpendIntentDeps,
} from "../src/lib/communities/commerce/funding-source/settlement-wiring"
import { getSpendIntent, type SpendIntentRow } from "../src/lib/communities/commerce/funding-source/spend-intent"
import type { PurchaseQuoteRow } from "../src/lib/communities/commerce/row-types"

const RESERVATION_FUTURE = "2026-04-21T00:10:00.000Z"
const NOW = "2026-04-21T00:05:00.000Z"
// A valid EVM address so walletBuyer/getAddress can normalize it.
const BUYER = "0x1111111111111111111111111111111111111111"

// Minimal-but-settleable quote covering exactly the fields the gate reads.
function settleableQuote(overrides?: Partial<PurchaseQuoteRow>): PurchaseQuoteRow {
  return {
    quote_id: "quo_wire",
    status: "active",
    expires_at: "2026-04-21T01:00:00.000Z",
    funding_mode: "routed",
    route_provider: "pirate_checkout",
    buyer_kind: "wallet",
    buyer_wallet_address_normalized: BUYER.toLowerCase(),
    buyer_chain_ref: "eip155",
    buyer_user_id: null,
    final_price_usd: 1,
    ...overrides,
  } as PurchaseQuoteRow
}

const SPEND_INTENTS_MIGRATION = readFileSync(
  resolveCoreRepoPath("db/control-plane/migrations/0119_control_plane_spend_intents.sql"),
  "utf8",
)

async function createControlPlaneClient() {
  const client = createClient({ url: ":memory:" })
  await client.execute("PRAGMA foreign_keys = OFF")
  for (const statement of splitSqlStatements(SPEND_INTENTS_MIGRATION)) {
    for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
      await client.execute(sqliteStatement)
    }
  }
  return client
}

async function insertIntent(
  client: ReturnType<typeof createClient>,
  overrides: {
    spendIntentId: string
    provider?: string
    communityId?: string | null
    quoteId?: string | null
    buyerAddress?: string | null
    status?: string
  },
) {
  await client.execute({
    sql: `
      INSERT INTO spend_intents (
        spend_intent_id, telegram_user_id, community_id, quote_id, buyer_address,
        funding_source_provider, price_reservation_expires_at, status, idempotency_key,
        created_at, updated_at
      ) VALUES (
        ?1, 'tg_1', ?2, ?3, ?4, ?5, ?6, ?8, ?7,
        '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z'
      )
    `,
    args: [
      overrides.spendIntentId,
      overrides.communityId === undefined ? "cmt_1" : overrides.communityId,
      overrides.quoteId === undefined ? "quo_wire" : overrides.quoteId,
      overrides.buyerAddress === undefined ? BUYER : overrides.buyerAddress,
      overrides.provider ?? "pirate_checkout",
      RESERVATION_FUTURE,
      `idem:${overrides.spendIntentId}`,
      overrides.status ?? "funding_pending",
    ],
  })
}

// A community-DB client sentinel — the wiring must hand THIS to the settlement confirmer, never
// the control-plane client.
const COMMUNITY_CLIENT = { marker: "community-db-client" }

function makeFakeDeps(overrides?: {
  confirm?: SettleSpendIntentDeps["confirmBuyerFundingForSettlement"]
  quote?: Partial<PurchaseQuoteRow>
}) {
  const calls = {
    openCommunityDbCount: 0,
    closeCount: 0,
    confirm: [] as Array<{ client: unknown; communityId: string; purchaseId: string; buyerAddress: string; fundingTxRef: string; quoteId: string }>,
  }
  const deps: SettleSpendIntentDeps = {
    openCommunityDb: (async (_env, _repo, _communityId) => {
      calls.openCommunityDbCount += 1
      return {
        client: COMMUNITY_CLIENT as never,
        close: () => {
          calls.closeCount += 1
        },
        databaseUrl: "file:fake",
      }
    }) as SettleSpendIntentDeps["openCommunityDb"],
    getPurchaseQuoteRow: (async (_client, _communityId, quoteId) => {
      return settleableQuote({ quote_id: quoteId, ...overrides?.quote })
    }) as SettleSpendIntentDeps["getPurchaseQuoteRow"],
    confirmBuyerFundingForSettlement:
      overrides?.confirm ??
      ((async (callInput) => {
        calls.confirm.push({
          client: callInput.client,
          communityId: callInput.communityId,
          purchaseId: callInput.purchaseId,
          buyerAddress: callInput.buyerAddress,
          fundingTxRef: callInput.fundingTxRef,
          quoteId: callInput.quote.quote_id,
        })
        return { txRef: callInput.fundingTxRef } as never
      }) as SettleSpendIntentDeps["confirmBuyerFundingForSettlement"]),
  }
  return { deps, calls }
}

describe("spend intent settlement wiring (pirate_checkout)", () => {
  test("drives control-plane intent and settles against the community DB", async () => {
    const cp = await createControlPlaneClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_w1" })
      const { deps, calls } = makeFakeDeps()

      const intent = await settlePirateCheckoutSpendIntent(
        {
          env: {} as never,
          controlPlaneClient: cp,
          communityRepository: {} as never,
          spendIntentId: "spi_w1",
          fundingTxRef: "0xBASEwire",
          now: NOW,
        },
        deps,
      )

      // Settlement ran against the COMMUNITY client with the derived purchase id + intent's buyer.
      expect(calls.confirm).toHaveLength(1)
      expect(calls.confirm[0]).toEqual({
        client: COMMUNITY_CLIENT,
        communityId: "cmt_1",
        purchaseId: "pur_wire", // derivePurchaseIdForQuote("quo_wire")
        buyerAddress: BUYER,
        fundingTxRef: "0xBASEwire", // the Base USDC tx, threaded through
        quoteId: "quo_wire",
      })
      // The control-plane intent reached funding_confirmed (funding boundary), receipt bound.
      // NOT "settled" — the purchase is not yet finalized (royalties/entitlement).
      expect(intent.status).toBe("funding_confirmed")
      expect(intent.funding_receipt_tx_ref).toBe("0xBASEwire")
      expect(calls.closeCount).toBe(1)
    } finally {
      cp.close()
    }
  })

  test("rejects an unresolved intent before opening any community DB", async () => {
    const cp = await createControlPlaneClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_unres", communityId: null })
      const { deps, calls } = makeFakeDeps()

      await expect(
        settlePirateCheckoutSpendIntent(
          {
            env: {} as never,
            controlPlaneClient: cp,
            communityRepository: {} as never,
            spendIntentId: "spi_unres",
            fundingTxRef: "0xBASEx",
            now: NOW,
          },
          deps,
        ),
      ).rejects.toThrow(/not resolved/i)

      expect(calls.openCommunityDbCount).toBe(0)
      const intent = await getSpendIntent({ client: cp, spendIntentId: "spi_unres" })
      expect(intent?.status).toBe("funding_pending")
    } finally {
      cp.close()
    }
  })

  test("runs the authorize hook with the loaded intent before opening the community DB", async () => {
    const cp = await createControlPlaneClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_auth" })
      const { deps, calls } = makeFakeDeps()
      const seen: string[] = []

      const intent = await settlePirateCheckoutSpendIntent(
        {
          env: {} as never,
          controlPlaneClient: cp,
          communityRepository: {} as never,
          spendIntentId: "spi_auth",
          fundingTxRef: "0xBASEauth",
          now: NOW,
          authorize: (loaded) => {
            seen.push(loaded.telegram_user_id)
          },
        },
        deps,
      )

      expect(seen).toEqual(["tg_1"]) // authorize saw the loaded intent
      expect(intent.status).toBe("funding_confirmed")
      expect(calls.confirm).toHaveLength(1)
    } finally {
      cp.close()
    }
  })

  test("authorize rejection aborts before opening the community DB", async () => {
    const cp = await createControlPlaneClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_forbid" })
      const { deps, calls } = makeFakeDeps()

      await expect(
        settlePirateCheckoutSpendIntent(
          {
            env: {} as never,
            controlPlaneClient: cp,
            communityRepository: {} as never,
            spendIntentId: "spi_forbid",
            fundingTxRef: "0xBASEx",
            now: NOW,
            authorize: () => {
              throw new Error("not the intent owner")
            },
          },
          deps,
        ),
      ).rejects.toThrow(/not the intent owner/i)

      expect(calls.openCommunityDbCount).toBe(0)
      expect(calls.confirm).toHaveLength(0)
    } finally {
      cp.close()
    }
  })

  test("rejects an intent not in a fundable state", async () => {
    const cp = await createControlPlaneClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_notfundable", status: "failed" })
      const { deps, calls } = makeFakeDeps()

      await expect(
        settlePirateCheckoutSpendIntent(
          {
            env: {} as never,
            controlPlaneClient: cp,
            communityRepository: {} as never,
            spendIntentId: "spi_notfundable",
            fundingTxRef: "0xBASEx",
            now: NOW,
          },
          deps,
        ),
      ).rejects.toThrow(/not in a fundable state/i)

      expect(calls.openCommunityDbCount).toBe(0)
    } finally {
      cp.close()
    }
  })

  test("rejects a non-pirate_checkout intent (TON not wired in this slice)", async () => {
    const cp = await createControlPlaneClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_ton", provider: "omniston_ton" })
      const { deps, calls } = makeFakeDeps()

      await expect(
        settlePirateCheckoutSpendIntent(
          {
            env: {} as never,
            controlPlaneClient: cp,
            communityRepository: {} as never,
            spendIntentId: "spi_ton",
            fundingTxRef: "0xBASEx",
            now: NOW,
          },
          deps,
        ),
      ).rejects.toThrow(/pirate_checkout only/i)

      expect(calls.openCommunityDbCount).toBe(0)
    } finally {
      cp.close()
    }
  })

  test("rejects when the intent buyer does not match the quote buyer, binding nothing", async () => {
    const cp = await createControlPlaneClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_mism" })
      // Quote is bound to a DIFFERENT wallet than the intent's buyer_address.
      const { deps, calls } = makeFakeDeps({
        quote: { buyer_wallet_address_normalized: "0x2222222222222222222222222222222222222222" },
      })

      await expect(
        settlePirateCheckoutSpendIntent(
          {
            env: {} as never,
            controlPlaneClient: cp,
            communityRepository: {} as never,
            spendIntentId: "spi_mism",
            fundingTxRef: "0xBASEx",
            now: NOW,
          },
          deps,
        ),
      ).rejects.toThrow(/buyer does not match/i)

      expect(calls.confirm).toHaveLength(0)
      expect(calls.closeCount).toBe(1) // opened to load the quote, then closed despite rejection
      const intent = await getSpendIntent({ client: cp, spendIntentId: "spi_mism" })
      expect(intent?.status).toBe("funding_pending")
    } finally {
      cp.close()
    }
  })

  test("settlement failure reverts the intent to funded and still closes the community DB", async () => {
    const cp = await createControlPlaneClient()
    try {
      await insertIntent(cp, { spendIntentId: "spi_fail" })
      const { deps, calls } = makeFakeDeps({
        confirm: (async () => {
          throw new Error("story settlement timed out")
        }) as SettleSpendIntentDeps["confirmBuyerFundingForSettlement"],
      })

      await expect(
        settlePirateCheckoutSpendIntent(
          {
            env: {} as never,
            controlPlaneClient: cp,
            communityRepository: {} as never,
            spendIntentId: "spi_fail",
            fundingTxRef: "0xBASEfail",
            now: NOW,
          },
          deps,
        ),
      ).rejects.toThrow(/story settlement timed out/i)

      const intent = await getSpendIntent({ client: cp, spendIntentId: "spi_fail" })
      expect(intent?.status).toBe("funded") // retryable; receipt stays bound
      expect(intent?.failure_reason).toBe("story settlement timed out")
      expect(intent?.funding_receipt_tx_ref).toBe("0xBASEfail")
      expect(calls.closeCount).toBe(1) // finally ran despite the throw
    } finally {
      cp.close()
    }
  })
})

function intentRow(overrides?: Partial<SpendIntentRow>): SpendIntentRow {
  return {
    spend_intent_id: "spi",
    telegram_user_id: "tg_1",
    user_id: null,
    community_id: "cmt_1",
    quote_id: "quo_wire",
    purchase_id: null,
    asset_id: null,
    buyer_address: BUYER,
    funding_source_provider: "pirate_checkout",
    price_reservation_expires_at: RESERVATION_FUTURE,
    funding_route_ref: null,
    funding_source_tx_ref: null,
    funding_receipt_tx_ref: null,
    status: "funding_pending",
    failure_reason: null,
    idempotency_key: "idem",
    created_at: "2026-04-21T00:00:00.000Z",
    updated_at: "2026-04-21T00:00:00.000Z",
    ...overrides,
  }
}

describe("assertQuoteSettleableForSpendIntent (gate matrix)", () => {
  test("passes for an active, routed, pirate_checkout, matching-wallet quote", () => {
    expect(() =>
      assertQuoteSettleableForSpendIntent({ intent: intentRow(), quote: settleableQuote(), now: NOW }),
    ).not.toThrow()
  })

  test("rejects an inactive quote", () => {
    expect(() =>
      assertQuoteSettleableForSpendIntent({ intent: intentRow(), quote: settleableQuote({ status: "consumed" }), now: NOW }),
    ).toThrow(/not active/i)
  })

  test("rejects an expired quote", () => {
    expect(() =>
      assertQuoteSettleableForSpendIntent({
        intent: intentRow(),
        quote: settleableQuote({ expires_at: "2026-04-21T00:04:00.000Z" }),
        now: NOW,
      }),
    ).toThrow(/expired/i)
  })

  test("rejects a non-routed quote", () => {
    expect(() =>
      assertQuoteSettleableForSpendIntent({ intent: intentRow(), quote: settleableQuote({ funding_mode: "direct" }), now: NOW }),
    ).toThrow(/routed/i)
  })

  test("rejects a non-pirate_checkout-routed quote", () => {
    expect(() =>
      assertQuoteSettleableForSpendIntent({ intent: intentRow(), quote: settleableQuote({ route_provider: "other" }), now: NOW }),
    ).toThrow(/pirate_checkout-routed/i)
  })

  test("rejects a wallet quote whose address differs from the intent", () => {
    expect(() =>
      assertQuoteSettleableForSpendIntent({
        intent: intentRow(),
        quote: settleableQuote({ buyer_wallet_address_normalized: "0x2222222222222222222222222222222222222222" }),
        now: NOW,
      }),
    ).toThrow(/buyer does not match/i)
  })

  test("rejects an invalid intent buyer wallet for a wallet quote", () => {
    expect(() =>
      assertQuoteSettleableForSpendIntent({ intent: intentRow({ buyer_address: "0xnotanaddress" }), quote: settleableQuote(), now: NOW }),
    ).toThrow(/not a valid address/i)
  })

  test("user-buyer quote matches on resolved user_id", () => {
    const quote = settleableQuote({ buyer_kind: "user", buyer_user_id: "usr_1", buyer_wallet_address_normalized: null })
    expect(() =>
      assertQuoteSettleableForSpendIntent({ intent: intentRow({ user_id: "usr_1" }), quote, now: NOW }),
    ).not.toThrow()
  })

  test("user-buyer quote rejects an absent or mismatched user", () => {
    const quote = settleableQuote({ buyer_kind: "user", buyer_user_id: "usr_1", buyer_wallet_address_normalized: null })
    expect(() =>
      assertQuoteSettleableForSpendIntent({ intent: intentRow({ user_id: null }), quote, now: NOW }),
    ).toThrow(/no resolved user/i)
    expect(() =>
      assertQuoteSettleableForSpendIntent({ intent: intentRow({ user_id: "usr_2" }), quote, now: NOW }),
    ).toThrow(/buyer does not match/i)
  })
})
