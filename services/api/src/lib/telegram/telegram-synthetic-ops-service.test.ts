import { describe, expect, test } from "bun:test"
import {
  cleanupTelegramSyntheticDelivery,
  findTelegramSyntheticFixture,
  getTelegramSyntheticDelivery,
} from "./telegram-synthetic-ops-service"

type Query = { sql: string; args: unknown[] }

function client(rowsFor: (query: Query) => unknown[]) {
  return {
    execute: async (query: Query) => ({ rows: rowsFor(query) }),
  }
}

const fixtureRow = {
  community_id: "cmt_fixture",
  channel_title: "Synthetic channel",
  creator_user_id: "usr_owner",
}

const deliveryRow = {
  telegram_post_delivery_id: "tpd_1",
  telegram_channel_destination_id: "tcd_1",
  telegram_community_bot_id: "tgb_1",
  community_id: "cmt_fixture",
  post_id: "pst_1",
  telegram_chat_id: "-1001",
  telegram_message_id: 42,
  status: "delivered",
  attempt_count: 1,
  last_error: null,
  updated_at: "2026-07-29T00:00:00.000Z",
}

describe("Telegram staging synthetic ops", () => {
  test("auto-discovers only a single active fixture", async () => {
    const fixture = await findTelegramSyntheticFixture({
      client: client(() => [fixtureRow]),
    })
    expect(fixture).toEqual({
      community_id: "com_cmt_fixture",
      owner_user_id: "usr_owner",
      channel_title: "Synthetic channel",
    })

    await expect(findTelegramSyntheticFixture({
      client: client(() => [fixtureRow, { ...fixtureRow, community_id: "cmt_other" }]),
    })).rejects.toThrow("Multiple Telegram channels are active")
  })

  test("scopes an explicitly configured fixture by raw community id", async () => {
    const capturedArgs: unknown[][] = []
    await findTelegramSyntheticFixture({
      client: client((value) => {
        capturedArgs.push(value.args)
        return [fixtureRow]
      }),
      communityId: "com_cmt_fixture",
    })
    expect(capturedArgs).toEqual([["cmt_fixture"]])
  })

  test("reports a delivery without exposing the Telegram chat id", async () => {
    const delivery = await getTelegramSyntheticDelivery({
      client: client(() => [deliveryRow]),
      postId: "post_pst_1",
      communityId: "com_cmt_fixture",
    })
    expect(delivery).toEqual({
      delivery_id: "tpd_1",
      community_id: "com_cmt_fixture",
      post_id: "post_pst_1",
      status: "delivered",
      attempt_count: 1,
      telegram_message_id: 42,
      last_error: null,
      updated_at: "2026-07-29T00:00:00.000Z",
    })
    expect(delivery).not.toHaveProperty("telegram_chat_id")
  })

  test("deletes the confirmed Telegram message before retiring the row", async () => {
    const calls: string[] = []
    const outcome = await cleanupTelegramSyntheticDelivery({
      env: {} as never,
      client: client((query) => {
        if (query.sql.includes("SELECT")) return [deliveryRow]
        calls.push("mark-deleted")
        return [{ telegram_post_delivery_id: "tpd_1" }]
      }),
      postId: "post_pst_1",
      communityId: "com_cmt_fixture",
      loadBot: (async () => ({ id: "tgb_1", token: "1:test" })) as never,
      deleteMessages: (async (
        _bot: { token: string },
        body: { chat_id: number | string; message_ids: number[] },
      ) => {
        calls.push("telegram-delete")
        expect(body).toEqual({ chat_id: "-1001", message_ids: [42] })
        return true
      }) as never,
    })
    expect(calls).toEqual(["telegram-delete", "mark-deleted"])
    expect(outcome.applied).toBe(true)
    expect(outcome.delivery.status).toBe("deleted")
  })

  test("does not claim cleanup for an ambiguous delivery without a message id", async () => {
    await expect(cleanupTelegramSyntheticDelivery({
      env: {} as never,
      client: client(() => [{
        ...deliveryRow,
        status: "uncertain",
        telegram_message_id: null,
      }]),
      postId: "post_pst_1",
    })).rejects.toThrow("no confirmed message")
  })

  test("cleanup is a no-op after the delivery is already retired", async () => {
    const outcome = await cleanupTelegramSyntheticDelivery({
      env: {} as never,
      client: client(() => [{ ...deliveryRow, status: "deleted" }]),
      postId: "post_pst_1",
    })
    expect(outcome.applied).toBe(false)
  })
})
