import { describe, expect, test } from "bun:test"
import {
  handleCreateTelegramSpendIntentProposal,
  type CreateTelegramSpendIntentProposalDeps,
} from "../src/lib/communities/commerce/funding-source/telegram-proposal"

const NOW = "2026-04-21T00:05:00.000Z"

function makeDeps(overrides?: {
  communityId?: string | null
  telegramUserId?: string
}) {
  const calls: Array<{
    telegramUserId: string
    communityId: string
    listingId: string
    idempotencyKey: string
  }> = []
  const deps: CreateTelegramSpendIntentProposalDeps = {
    getCommunityRepository: () => ({}) as never,
    resolveCommunityId: async () => overrides?.communityId === undefined ? "cmt_1" : overrides.communityId,
    verifyMiniAppUser: () => ({ id: overrides?.telegramUserId ?? "tg_1" }),
    createProposal: async (input) => {
      calls.push({
        telegramUserId: input.telegramUserId,
        communityId: input.communityId,
        listingId: input.listingId,
        idempotencyKey: input.idempotencyKey,
      })
      return {
        spendIntentId: "spi_1",
        status: "proposed",
        title: "Concrete Jungle",
        priceUsd: 3,
        fundingProvider: "ton_testnet_transfer",
        reservationExpiresAt: "2026-04-21T00:35:00.000Z",
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
  listing_id: "lst_abc",
  idempotency_key: "retry-1",
  ...extra,
})

describe("Telegram spend-intent proposal route core", () => {
  test("creates a non-completing Telegram-bound proposal from Mini App identity", async () => {
    const { deps, calls } = makeDeps({ telegramUserId: "tg_777" })
    const result = await handleCreateTelegramSpendIntentProposal({ env: {} as never, body: body(), now: NOW }, deps)

    expect(result).toMatchObject({
      spendIntentId: "spi_1",
      status: "proposed",
      fundingProvider: "ton_testnet_transfer",
      purchaseComplete: false,
      fundsMoved: false,
    })
    expect(calls).toEqual([{
      telegramUserId: "tg_777",
      communityId: "cmt_1",
      listingId: "lst_abc",
      idempotencyKey: "retry-1",
    }])
  })

  test("requires idempotency key and listing before creating anything", async () => {
    const { deps, calls } = makeDeps()
    await expect(
      handleCreateTelegramSpendIntentProposal({
        env: {} as never,
        body: body({ idempotency_key: "" }),
        now: NOW,
      }, deps),
    ).rejects.toThrow(/idempotency_key/i)
    expect(calls).toEqual([])
  })

  test("rejects unknown communities", async () => {
    const { deps, calls } = makeDeps({ communityId: null })
    await expect(
      handleCreateTelegramSpendIntentProposal({ env: {} as never, body: body(), now: NOW }, deps),
    ).rejects.toThrow(/community/i)
    expect(calls).toEqual([])
  })
})
