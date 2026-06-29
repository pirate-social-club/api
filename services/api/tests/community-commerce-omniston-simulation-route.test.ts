import { describe, expect, test } from "bun:test"
import {
  handleConfirmSimulatedOmnistonFunding,
  handleStartSimulatedOmnistonFunding,
  type ConfirmSimulatedOmnistonRouteDeps,
  type StartSimulatedOmnistonRouteDeps,
} from "../src/lib/communities/commerce/funding-source/omniston-simulation-route"
import { selectFundingProvider } from "../src/lib/communities/commerce/funding-source/accept-proposal"
import { expectedTonPayload } from "../src/lib/communities/commerce/funding-source/ton-testnet-resolver"

const NOW = "2026-04-21T00:05:00.000Z"

function common(overrides?: {
  enabled?: boolean
  authedTelegramUserId?: string
  intentOwnerTelegramUserId?: string
  intentCommunityId?: string | null
}) {
  return {
    omnistonSimulationEnabled: overrides?.enabled ?? true,
    getCommunityRepository: () => ({}) as never,
    resolveCommunityId: async () => "cmt_1",
    verifyMiniAppUser: () => ({ id: overrides?.authedTelegramUserId ?? "tg_1" }),
    authorizeIntent: async (input: { authorize?: (intent: never) => void | Promise<void>; spendIntentId: string }) => {
      const intent = {
        spend_intent_id: input.spendIntentId,
        telegram_user_id: overrides?.intentOwnerTelegramUserId ?? "tg_1",
        community_id: overrides?.intentCommunityId === undefined ? "cmt_1" : overrides.intentCommunityId,
      } as never
      await input.authorize?.(intent)
    },
  }
}

function startDeps(overrides?: Parameters<typeof common>[0]) {
  const calls = { runStart: 0 }
  const base = common(overrides)
  const deps: StartSimulatedOmnistonRouteDeps = {
    ...base,
    runStart: async (input) => {
      calls.runStart += 1
      await base.authorizeIntent({ authorize: input.authorize as never, spendIntentId: input.spendIntentId })
      return {
        spend_intent_id: input.spendIntentId,
        status: "funding_pending",
      } as never
    },
  }
  return { deps, calls }
}

function confirmDeps(overrides?: Parameters<typeof common>[0] & { status?: string }) {
  const calls = { runConfirm: 0, simulatedRoute: null as unknown }
  const base = common(overrides)
  const deps: ConfirmSimulatedOmnistonRouteDeps = {
    ...base,
    runConfirm: async (input) => {
      calls.runConfirm += 1
      calls.simulatedRoute = input.simulatedRoute
      await base.authorizeIntent({ authorize: input.authorize as never, spendIntentId: input.spendIntentId })
      return {
        spend_intent_id: input.spendIntentId,
        status: overrides?.status ?? "funding_confirmed",
      } as never
    },
  }
  return { deps, calls }
}

const body = (extra?: Record<string, unknown>) => ({
  community_id: "my-community",
  init_data: "user=...&hash=...",
  spend_intent_id: "spi_1",
  ...extra,
})

describe("simulated Omniston dev routes", () => {
  test("start route is hidden when disabled and does not open the production accept gate", async () => {
    const { deps, calls } = startDeps({ enabled: false })
    await expect(handleStartSimulatedOmnistonFunding({ env: {} as never, body: body(), now: NOW }, deps)).rejects.toThrow(/not found/i)
    expect(calls.runStart).toBe(0)
    expect(() => selectFundingProvider("omniston_ton", { tonTestnetEnabled: true })).toThrow(/not yet available/i)
  })

  test("start route reaches only the separate simulation entry when enabled", async () => {
    const { deps, calls } = startDeps()
    const result = await handleStartSimulatedOmnistonFunding({ env: {} as never, body: body(), now: NOW }, deps)
    expect(result).toEqual({
      intentId: "spi_1",
      status: "funding_pending",
      purchaseComplete: false,
      fundsMoved: false,
    })
    expect(calls.runStart).toBe(1)
  })

  test("confirm route is hidden when disabled", async () => {
    const { deps, calls } = confirmDeps({ enabled: false })
    await expect(
      handleConfirmSimulatedOmnistonFunding({ env: {} as never, body: body({ route_ref: "route_1", min_base_usdc_atomic: "3000000" }), now: NOW }, deps),
    ).rejects.toThrow(/not found/i)
    expect(calls.runConfirm).toBe(0)
  })

  test("confirm route parses simulated route evidence and never claims purchase completion", async () => {
    const { deps, calls } = confirmDeps()
    const result = await handleConfirmSimulatedOmnistonFunding({
      env: {} as never,
      body: body({
        route_ref: "route_1",
        min_base_usdc_atomic: "3000000",
        simulated_route: {
          route_ref: "route_1",
          source_tx_ref: "ton-source-1",
          source_payload: expectedTonPayload("spi_1"),
          destination_tx_ref: "base-delivery-1",
          delivered_base_usdc_atomic: "3000000",
          status: "delivered",
        },
      }),
      now: NOW,
    }, deps)
    expect(result).toEqual({
      intentId: "spi_1",
      status: "funding_confirmed",
      routeRef: "route_1",
      purchaseComplete: false,
      fundsMoved: false,
    })
    expect(calls.runConfirm).toBe(1)
    expect(calls.simulatedRoute).toMatchObject({
      routeRef: "route_1",
      sourceTxRef: "ton-source-1",
      destinationTxRef: "base-delivery-1",
      status: "delivered",
    })
  })

  test("non-owner simulation access is not found", async () => {
    const { deps } = confirmDeps({ authedTelegramUserId: "tg_OTHER" })
    await expect(
      handleConfirmSimulatedOmnistonFunding({ env: {} as never, body: body({ route_ref: "route_1", min_base_usdc_atomic: "3000000" }), now: NOW }, deps),
    ).rejects.toThrow(/not found/i)
  })

  test("confirm route requires route fields and valid simulated route status", async () => {
    const { deps } = confirmDeps()
    await expect(
      handleConfirmSimulatedOmnistonFunding({ env: {} as never, body: body(), now: NOW }, deps),
    ).rejects.toThrow(/route_ref/i)
    await expect(
      handleConfirmSimulatedOmnistonFunding({
        env: {} as never,
        body: body({
          route_ref: "route_1",
          min_base_usdc_atomic: "3000000",
          simulated_route: { route_ref: "route_1", status: "unknown" },
        }),
        now: NOW,
      }, deps),
    ).rejects.toThrow(/simulated_route.status/i)
  })
})
