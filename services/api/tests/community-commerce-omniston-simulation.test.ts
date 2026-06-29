import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createClient } from "@libsql/client"
import { resolveCoreRepoPath } from "../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import { advanceSpendIntentFunding, getSpendIntent } from "../src/lib/communities/commerce/funding-source/spend-intent"
import { confirmSimulatedOmnistonFunding } from "../src/lib/communities/commerce/funding-source/omniston-simulation-confirm"
import {
  MOCK_OMNISTON_BASE_PREFIX,
  createSimulatedOmnistonAcquisitionResolver,
  isMockOmnistonBaseTxRef,
  mapSimulatedSymbiosisStatusToRoute,
  mapSimulatedOmnistonRouteToAcquisition,
  type SimulatedOmnistonClient,
  type SimulatedOmnistonRoute,
} from "../src/lib/communities/commerce/funding-source/omniston-simulation-resolver"
import { expectedTonPayload } from "../src/lib/communities/commerce/funding-source/ton-testnet-resolver"
import type { FundingSourceAcquireInput } from "../src/lib/communities/commerce/funding-source/types"

const NOW = "2026-04-21T00:05:00.000Z"
const RESERVATION_FUTURE = "2026-04-21T01:00:00.000Z"
const SPI = "spi_omni1"
const ROUTE = "symbiosis-route-1"
const ACQUIRE: FundingSourceAcquireInput = { provider: "omniston_ton", routeRef: ROUTE }
const EXPECT = { spendIntentId: SPI, minBaseUsdcAtomic: "3000000" }

function deliveredRoute(overrides: Partial<SimulatedOmnistonRoute> = {}): SimulatedOmnistonRoute {
  return {
    routeRef: ROUTE,
    sourceTxRef: "ton-source-1",
    sourcePayload: expectedTonPayload(SPI),
    destinationTxRef: "base-delivery-1",
    deliveredBaseUsdcAtomic: "3000000",
    status: "delivered",
    ...overrides,
  }
}

describe("simulated Omniston route -> acquisition mapping", () => {
  test("delivered route maps to a namespaced mock Base ref", () => {
    const result = mapSimulatedOmnistonRouteToAcquisition(deliveredRoute(), ACQUIRE, EXPECT)
    expect(result.status).toBe("confirmed")
    if (result.status !== "confirmed") throw new Error("unreachable")
    expect(result.baseUsdcTxRef).toBe(`${MOCK_OMNISTON_BASE_PREFIX}base-delivery-1`)
    expect(isMockOmnistonBaseTxRef(result.baseUsdcTxRef)).toBe(true)
    expect(result.baseUsdcTxRef.startsWith("0x")).toBe(false)
    expect(result.sourceCorrelation.kind).toBe("omniston_ton")
    expect(result.sourceCorrelation.routeRef).toBe(ROUTE)
    expect(result.sourceCorrelation.sourceTxRef).toBe("ton-source-1")
  })

  test("Symbiosis-shaped success maps through provider-generated payload attribution", () => {
    const route = mapSimulatedSymbiosisStatusToRoute({
      routeRef: ROUTE,
      status: {
        status: { code: 0, text: "Success" },
        txIn: {
          hash: "ton-source-symbiosis",
          chainId: 85918,
          tokenAmount: { amount: "1000000" },
        },
        tx: {
          hash: "base-native-usdc-delivery",
          chainId: 8453,
          tokenAmount: { amount: "3000000" },
        },
      },
    })
    const result = mapSimulatedOmnistonRouteToAcquisition(route, ACQUIRE, EXPECT)
    expect(result.status).toBe("confirmed")
    if (result.status !== "confirmed") throw new Error("unreachable")
    expect(result.baseUsdcTxRef).toBe(`${MOCK_OMNISTON_BASE_PREFIX}base-native-usdc-delivery`)
    expect(result.sourceCorrelation.sourceTxRef).toBe("ton-source-symbiosis")
  })

  test("pending or missing route stays pending", () => {
    expect(mapSimulatedOmnistonRouteToAcquisition(null, ACQUIRE, EXPECT).status).toBe("pending")
    expect(mapSimulatedOmnistonRouteToAcquisition(deliveredRoute({ status: "pending", destinationTxRef: null }), ACQUIRE, EXPECT).status).toBe("pending")
  })

  test("route, payload, underdelivery, and failure mismatches fail refundable", () => {
    const cases = [
      deliveredRoute({ routeRef: "other-route" }),
      deliveredRoute({ sourcePayload: `${expectedTonPayload(SPI)} extra` }),
      deliveredRoute({ deliveredBaseUsdcAtomic: "2999999" }),
      deliveredRoute({ status: "cancelled" }),
      deliveredRoute({ status: "failed" }),
    ]
    for (const route of cases) {
      const result = mapSimulatedOmnistonRouteToAcquisition(route, ACQUIRE, EXPECT)
      expect(result.status).toBe("failed")
      if (result.status !== "failed") throw new Error("unreachable")
      expect(result.refundable).toBe(true)
    }
  })

  test("provider-generated payload route still requires a source tx for attribution", () => {
    const result = mapSimulatedOmnistonRouteToAcquisition(
      deliveredRoute({ sourcePayloadMode: "provider_generated", sourcePayload: null, sourceTxRef: null }),
      ACQUIRE,
      EXPECT,
    )
    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("unreachable")
    expect(result.reason).toMatch(/source transaction/i)
    expect(result.refundable).toBe(true)
  })

  test("Symbiosis-shaped pending and failure statuses do not bind a receipt", () => {
    expect(mapSimulatedSymbiosisStatusToRoute({ routeRef: ROUTE, status: null })).toBeNull()
    const pending = mapSimulatedSymbiosisStatusToRoute({
      routeRef: ROUTE,
      status: { status: { code: 1, text: "Pending" }, txIn: { hash: "ton-pending" } },
    })
    expect(mapSimulatedOmnistonRouteToAcquisition(pending, ACQUIRE, EXPECT).status).toBe("pending")

    const failed = mapSimulatedSymbiosisStatusToRoute({
      routeRef: ROUTE,
      status: { status: { code: 3, text: "Reverted" }, txIn: { hash: "ton-reverted" } },
    })
    const result = mapSimulatedOmnistonRouteToAcquisition(failed, ACQUIRE, EXPECT)
    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("unreachable")
    expect(result.refundable).toBe(true)
  })

  test("resolver looks up by routeRef and rejects a missing route ref", async () => {
    const seen: string[] = []
    const client: SimulatedOmnistonClient = {
      getRoute: async (routeRef) => {
        seen.push(routeRef)
        return deliveredRoute()
      },
    }
    const resolver = createSimulatedOmnistonAcquisitionResolver({ client, expectations: EXPECT })
    const result = await resolver(ACQUIRE)
    expect(seen).toEqual([ROUTE])
    expect(result.status).toBe("confirmed")
    await expect(resolver({ provider: "omniston_ton" })).rejects.toThrow(/routeRef/i)
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

async function insertOmnistonIntent(
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
      opts?.provider ?? "omniston_ton",
      RESERVATION_FUTURE,
      opts?.status ?? "funding_pending",
      `idem:${id}`,
    ],
  })
}

const omnistonClientReturning = (route: SimulatedOmnistonRoute | null): { client: SimulatedOmnistonClient } => ({
  client: { getRoute: async () => route },
})

describe("confirmSimulatedOmnistonFunding (dev bridge simulation)", () => {
  test("a delivered route drives the intent to funding_confirmed with mock refs only", async () => {
    const cp = await createCpClient()
    try {
      await insertOmnistonIntent(cp)
      const intent = await confirmSimulatedOmnistonFunding(
        { controlPlaneClient: cp, spendIntentId: SPI, routeRef: ROUTE, minBaseUsdcAtomic: "3000000", now: NOW },
        omnistonClientReturning(deliveredRoute()),
      )
      expect(intent.status).toBe("funding_confirmed")
      expect(intent.funding_route_ref).toBe(ROUTE)
      expect(intent.funding_source_tx_ref).toBe("ton-source-1")
      expect(intent.funding_receipt_tx_ref).toBe(`${MOCK_OMNISTON_BASE_PREFIX}base-delivery-1`)
      expect(intent.purchase_id).toBeNull()
    } finally {
      cp.close()
    }
  })

  test("pending route persists correlation without binding a receipt", async () => {
    const cp = await createCpClient()
    try {
      await insertOmnistonIntent(cp)
      const intent = await confirmSimulatedOmnistonFunding(
        { controlPlaneClient: cp, spendIntentId: SPI, routeRef: ROUTE, minBaseUsdcAtomic: "3000000", now: NOW },
        omnistonClientReturning(deliveredRoute({ status: "pending", destinationTxRef: null })),
      )
      expect(intent.status).toBe("funding_pending")
      expect(intent.funding_route_ref).toBe(ROUTE)
      expect(intent.funding_receipt_tx_ref).toBeNull()
    } finally {
      cp.close()
    }
  })

  test("mismatched route becomes refundable with no receipt bound", async () => {
    const cp = await createCpClient()
    try {
      await insertOmnistonIntent(cp)
      const intent = await confirmSimulatedOmnistonFunding(
        { controlPlaneClient: cp, spendIntentId: SPI, routeRef: ROUTE, minBaseUsdcAtomic: "3000000", now: NOW },
        omnistonClientReturning(deliveredRoute({ sourcePayload: "wrong payload" })),
      )
      expect(intent.status).toBe("refundable")
      expect(intent.failure_reason).toMatch(/payload/i)
      expect(intent.funding_receipt_tx_ref).toBeNull()
    } finally {
      cp.close()
    }
  })

  test("rejects a real-looking Base ref at the dev settle guard", async () => {
    const cp = await createCpClient()
    try {
      await insertOmnistonIntent(cp)
      const maliciousResolver = async () => ({
        status: "confirmed" as const,
        baseUsdcTxRef: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        sourceCorrelation: {
          kind: "omniston_ton" as const,
          routeRef: ROUTE,
          sourceTxRef: "ton-source-1",
          baseUsdcTxRef: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        },
      })
      await expect(
        advanceSpendIntentFunding({
          client: cp,
          spendIntentId: SPI,
          acquireInput: { provider: "omniston_ton", routeRef: ROUTE },
          now: NOW,
          resolveAcquisition: maliciousResolver,
          settle: async (baseUsdcTxRef) => {
            if (!isMockOmnistonBaseTxRef(baseUsdcTxRef)) {
              throw new Error("simulated Omniston dev settle received a non-mock funding ref")
            }
          },
        }),
      ).rejects.toThrow(/non-mock funding ref/i)
      const intent = await getSpendIntent({ client: cp, spendIntentId: SPI })
      expect(intent?.status).toBe("funded")
      expect(intent?.funding_receipt_tx_ref).toMatch(/^0x/)
    } finally {
      cp.close()
    }
  })

  test("rejects a non-omniston provider and non-fundable states", async () => {
    const cp = await createCpClient()
    try {
      await insertOmnistonIntent(cp, { spendIntentId: "spi_wrong_provider", provider: "ton_testnet_transfer" })
      await expect(
        confirmSimulatedOmnistonFunding(
          { controlPlaneClient: cp, spendIntentId: "spi_wrong_provider", routeRef: ROUTE, minBaseUsdcAtomic: "3000000", now: NOW },
          omnistonClientReturning(deliveredRoute()),
        ),
      ).rejects.toThrow(/not an omniston_ton intent/i)

      await insertOmnistonIntent(cp, { spendIntentId: "spi_wrong_state", status: "proposed" })
      await expect(
        confirmSimulatedOmnistonFunding(
          { controlPlaneClient: cp, spendIntentId: "spi_wrong_state", routeRef: ROUTE, minBaseUsdcAtomic: "3000000", now: NOW },
          omnistonClientReturning(deliveredRoute()),
        ),
      ).rejects.toThrow(/not in a fundable state/i)
    } finally {
      cp.close()
    }
  })
})
