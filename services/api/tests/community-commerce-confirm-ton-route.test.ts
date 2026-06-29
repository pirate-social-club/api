import { describe, expect, test } from "bun:test"
import {
  handleTonTestnetConfirm,
  type ConfirmTonRouteDeps,
} from "../src/lib/communities/commerce/funding-source/confirm-ton-route"

const NOW = "2026-04-21T00:05:00.000Z"

function makeDeps(overrides?: {
  tonTestnetEnabled?: boolean
  authedTelegramUserId?: string
  intentOwnerTelegramUserId?: string
  intentCommunityId?: string | null
  resultStatus?: string
}) {
  const calls = { runConfirm: 0 }
  const deps: ConfirmTonRouteDeps = {
    tonTestnetEnabled: overrides?.tonTestnetEnabled ?? true,
    getCommunityRepository: () => ({}) as never,
    resolveCommunityId: async () => "cmt_1",
    verifyMiniAppUser: () => ({ id: overrides?.authedTelegramUserId ?? "tg_1" }),
    runConfirm: async (input) => {
      calls.runConfirm += 1
      const intent = {
        spend_intent_id: input.spendIntentId,
        telegram_user_id: overrides?.intentOwnerTelegramUserId ?? "tg_1",
        community_id: overrides?.intentCommunityId === undefined ? "cmt_1" : overrides.intentCommunityId,
        status: overrides?.resultStatus ?? "funding_confirmed",
      } as never
      await input.authorize?.(intent)
      return intent
    },
  }
  return { deps, calls }
}

const body = (extra?: Record<string, unknown>) => ({
  community_id: "my-community",
  init_data: "user=...&hash=...",
  spend_intent_id: "spi_1",
  ton_tx_hash: "ton-hash-1",
  ...extra,
})

describe("ton testnet confirm route handler", () => {
  test("disabled -> behaves as not found, never calls confirm", async () => {
    const { deps, calls } = makeDeps({ tonTestnetEnabled: false })
    await expect(handleTonTestnetConfirm({ env: {} as never, body: body(), now: NOW }, deps)).rejects.toThrow(/not found/i)
    expect(calls.runConfirm).toBe(0)
  })

  test("owner + community -> returns funding state, never purchase-complete", async () => {
    const { deps, calls } = makeDeps()
    const result = await handleTonTestnetConfirm({ env: {} as never, body: body(), now: NOW }, deps)
    expect(result).toEqual({
      intentId: "spi_1",
      status: "funding_confirmed",
      purchaseComplete: false,
      fundsMoved: false,
    })
    expect(calls.runConfirm).toBe(1)
  })

  test("a refundable outcome is reported honestly", async () => {
    const { deps } = makeDeps({ resultStatus: "refundable" })
    const result = await handleTonTestnetConfirm({ env: {} as never, body: body(), now: NOW }, deps)
    expect(result.status).toBe("refundable")
    expect(result.purchaseComplete).toBe(false)
  })

  test("non-owner -> not found", async () => {
    const { deps } = makeDeps({ authedTelegramUserId: "tg_OTHER" })
    await expect(handleTonTestnetConfirm({ env: {} as never, body: body(), now: NOW }, deps)).rejects.toThrow(/not found/i)
  })

  test("missing ton_tx_hash -> bad request", async () => {
    const { deps } = makeDeps()
    await expect(
      handleTonTestnetConfirm({ env: {} as never, body: body({ ton_tx_hash: "" }), now: NOW }, deps),
    ).rejects.toThrow(/required/i)
  })
})
