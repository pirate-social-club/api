import { describe, expect, test } from "bun:test"
import {
  handleConfirmSpendIntentFunding,
  type ConfirmFundingDeps,
} from "../src/lib/communities/commerce/funding-source/confirm-funding-route"

const NOW = "2026-04-21T00:05:00.000Z"

function makeDeps(overrides?: {
  authedTelegramUserId?: string
  intentOwnerTelegramUserId?: string
  resolvedCommunityId?: string | null
  intentCommunityId?: string | null
  intentStatus?: string
}) {
  const calls = { runSettle: 0, authorizeRan: false }
  const deps: ConfirmFundingDeps = {
    getCommunityRepository: () => ({}) as never,
    resolveCommunityId: async () =>
      overrides?.resolvedCommunityId === undefined ? "cmt_1" : overrides.resolvedCommunityId,
    verifyMiniAppUser: () => ({ id: overrides?.authedTelegramUserId ?? "tg_1" }),
    runSettle: async (input) => {
      calls.runSettle += 1
      const intent = {
        spend_intent_id: input.spendIntentId,
        telegram_user_id: overrides?.intentOwnerTelegramUserId ?? "tg_1",
        community_id: overrides?.intentCommunityId === undefined ? "cmt_1" : overrides.intentCommunityId,
        status: overrides?.intentStatus ?? "funding_confirmed",
      } as never
      // Exercise the authorization hook the handler supplied (ownership check lives there).
      calls.authorizeRan = true
      await input.authorize?.(intent)
      return intent
    },
  }
  return { deps, calls }
}

const validBody = {
  community_id: "my-community",
  init_data: "user=...&hash=...",
  spend_intent_id: "spi_1",
  funding_tx_ref: "0xBASE1",
}

describe("confirm-funding route handler", () => {
  test("intent owner: returns funding_confirmed and never implies purchase completion", async () => {
    const { deps, calls } = makeDeps({ authedTelegramUserId: "tg_1", intentOwnerTelegramUserId: "tg_1" })
    const result = await handleConfirmSpendIntentFunding({ env: {} as never, body: validBody, now: NOW }, deps)

    expect(result).toEqual({
      intentId: "spi_1",
      status: "funding_confirmed",
      purchaseComplete: false,
    })
    // Review gate #2: no entitlement/unlock fields, purchaseComplete strictly false.
    expect(Object.keys(result).sort()).toEqual(["intentId", "purchaseComplete", "status"])
    expect(result.purchaseComplete).toBe(false)
    expect(calls.runSettle).toBe(1)
  })

  test("non-owner: rejects as not found (existence not leaked)", async () => {
    const { deps } = makeDeps({ authedTelegramUserId: "tg_OTHER", intentOwnerTelegramUserId: "tg_1" })
    await expect(
      handleConfirmSpendIntentFunding({ env: {} as never, body: validBody, now: NOW }, deps),
    ).rejects.toThrow(/not found/i)
  })

  test("rejects when the intent belongs to a different community than the authed one", async () => {
    // Authed via cmt_1's bot tokens, but the intent resolved to cmt_other.
    const { deps } = makeDeps({ intentCommunityId: "cmt_other" })
    await expect(
      handleConfirmSpendIntentFunding({ env: {} as never, body: validBody, now: NOW }, deps),
    ).rejects.toThrow(/not found/i)
  })

  test("rejects a pre-community (unresolved) intent — community_id null can never be confirmed", async () => {
    const { deps } = makeDeps({ intentCommunityId: null })
    await expect(
      handleConfirmSpendIntentFunding({ env: {} as never, body: validBody, now: NOW }, deps),
    ).rejects.toThrow(/not found/i)
  })

  test("missing required fields are rejected before any auth/settlement", async () => {
    const { deps, calls } = makeDeps()
    await expect(
      handleConfirmSpendIntentFunding(
        { env: {} as never, body: { ...validBody, funding_tx_ref: "" }, now: NOW },
        deps,
      ),
    ).rejects.toThrow(/required/i)
    expect(calls.runSettle).toBe(0)
  })

  test("unknown community is rejected", async () => {
    const { deps } = makeDeps({ resolvedCommunityId: null })
    await expect(
      handleConfirmSpendIntentFunding({ env: {} as never, body: validBody, now: NOW }, deps),
    ).rejects.toThrow(/community was not found/i)
  })

  test("a refundable outcome is reported honestly, still not purchase-complete", async () => {
    // If the receipt landed after reservation expiry the orchestrator returns refundable; the
    // route must surface that truthfully rather than claim funding_confirmed.
    const { deps } = makeDeps({ intentStatus: "refundable" })
    const result = await handleConfirmSpendIntentFunding({ env: {} as never, body: validBody, now: NOW }, deps)
    expect(result.status).toBe("refundable")
    expect(result.purchaseComplete).toBe(false)
  })
})
