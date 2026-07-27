import { beforeEach, describe, expect, test } from "bun:test"
import {
  publishPostProjectionToTelegram,
  type TelegramPublishDeps,
} from "./channel-publishing-service"

// Dependencies are injected, not module-mocked: `bun test src tests/lib` runs
// this package in one process, so a mock.module on runtime-deps would replace
// the control-plane client for every other suite too.

type Execution = { sql: string; args: unknown[] }

let calls: string[] = []
let executions: Execution[] = []
let deliveryRow: Record<string, unknown> | null = null
let sendFails = false
let confirmWriteFails = false

function classify(sql: string): string {
  const text = sql.replace(/\s+/gu, " ").trim().toUpperCase()
  if (text.startsWith("SELECT") && text.includes("TELEGRAM_CHANNEL_DESTINATIONS")) return "select:destination"
  if (text.startsWith("SELECT") && text.includes("TELEGRAM_POST_DELIVERIES")) return "select:delivery"
  if (text.startsWith("INSERT") && text.includes("TELEGRAM_POST_DELIVERIES")) return "reserve"
  if (text.includes("STATUS = 'DELIVERED'")) return "confirm"
  if (text.includes("STATUS = 'FAILED'")) return "fail"
  if (text.includes("STATUS = 'UNCERTAIN'")) return "uncertain"
  return "other"
}

function deps(): TelegramPublishDeps {
  return {
    controlPlane: {
      execute: async ({ sql, args }: { sql: string; args: unknown[] }) => {
        const kind = classify(sql)
        calls.push(kind)
        executions.push({ sql, args })
        if (kind === "select:destination") {
          return {
            rows: [{
              telegram_channel_destination_id: "tcd_1",
              telegram_community_bot_id: "tgb_1",
              telegram_chat_id: "-1001",
              publication_mode: "from_now",
            }],
          }
        }
        if (kind === "select:delivery") {
          return { rows: deliveryRow ? [deliveryRow] : [] }
        }
        if (kind === "confirm" && confirmWriteFails) {
          throw new Error("control plane write failed")
        }
        return { rows: [] }
      },
    },
    loadBot: (async () => ({ id: "tgb_1" })) as unknown as TelegramPublishDeps["loadBot"],
    telegram: {
      sendMessage: (async () => {
        calls.push("telegram:sendMessage")
        if (sendFails) throw new Error("telegram rejected the send")
        return { message_id: 555 }
      }) as unknown as TelegramPublishDeps["telegram"]["sendMessage"],
      sendPhoto: (async () => {
        calls.push("telegram:sendPhoto")
        return { message_id: 556 }
      }) as unknown as TelegramPublishDeps["telegram"]["sendPhoto"],
      sendVideo: (async () => {
        calls.push("telegram:sendVideo")
        return { message_id: 557 }
      }) as unknown as TelegramPublishDeps["telegram"]["sendVideo"],
      editCaption: (async () => {
        calls.push("telegram:editCaption")
        return { message_id: 555 }
      }) as unknown as TelegramPublishDeps["telegram"]["editCaption"],
      editText: (async () => {
        calls.push("telegram:editText")
        return { message_id: 555 }
      }) as unknown as TelegramPublishDeps["telegram"]["editText"],
    },
  }
}

const env = { PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.test" } as never

function projection() {
  return {
    community_id: "cmt_1",
    source_post_id: "pst_1",
    status: "published",
    visibility: "public",
    updated_at: "2026-07-27T00:00:00.000Z",
    projected_payload_json: JSON.stringify({
      status: "published",
      visibility: "public",
      title: "Hello",
    }),
  } as never
}

function publish() {
  return publishPostProjectionToTelegram({ env, projection: projection() }, deps())
}

describe("Telegram delivery reservation", () => {
  beforeEach(() => {
    calls = []
    executions = []
    deliveryRow = null
    sendFails = false
    confirmWriteFails = false
  })

  test("reserves the delivery row before sending to Telegram", async () => {
    await publish()

    expect(calls).toEqual([
      "select:destination",
      "select:delivery",
      "reserve",
      "telegram:sendMessage",
      "confirm",
    ])
    // The ordering is the guarantee: a crash between the reserve and the
    // confirm can never leave Telegram holding a message we have no record of.
    expect(calls.indexOf("reserve")).toBeLessThan(calls.indexOf("telegram:sendMessage"))
  })

  test("marks a pre-send failure retryable", async () => {
    sendFails = true
    await expect(publish()).rejects.toThrow()
    expect(calls).toContain("fail")
    expect(calls).not.toContain("uncertain")
  })

  test("does not mark a post-send write failure retryable", async () => {
    confirmWriteFails = true
    await expect(publish()).rejects.toThrow()
    // Telegram already has the message. Recording 'failed' here is what would
    // let the job retry and post a duplicate.
    expect(calls).toContain("uncertain")
    expect(calls).not.toContain("fail")
  })

  test("never re-sends a delivery already classified uncertain", async () => {
    // Exactly the row the previous test leaves behind.
    deliveryRow = {
      telegram_post_delivery_id: "tpd_1",
      telegram_message_id: null,
      content_hash: "stale",
      status: "uncertain",
      attempt_count: 1,
    }

    const result = await publish()

    expect(result).toBeNull()
    expect(calls).not.toContain("telegram:sendMessage")
    expect(calls).not.toContain("reserve")
    expect(calls).toContain("uncertain")
  })

  test("reserves as 'sending', the durable in-flight marker", async () => {
    await publish()
    const reserve = executions.find((execution) => classify(execution.sql) === "reserve")
    // 'pending' here would be the original bug: a crash after the send would be
    // indistinguishable from a row that never left, and get retried.
    expect(reserve?.sql).toContain("'sending'")
  })

  test("promotes a stale 'sending' row to uncertain instead of re-sending it", async () => {
    // A previous attempt died between the reserve and recording any outcome —
    // process kill, isolate eviction — so it may or may not have hit Telegram.
    deliveryRow = {
      telegram_post_delivery_id: "tpd_1",
      telegram_message_id: null,
      content_hash: "stale",
      status: "sending",
      attempt_count: 1,
    }

    const result = await publish()

    expect(result).toBeNull()
    expect(calls).not.toContain("telegram:sendMessage")
    expect(calls).not.toContain("reserve")
    expect(calls).toContain("uncertain")
  })

  test("retries a delivery that definitively failed before the send", async () => {
    deliveryRow = {
      telegram_post_delivery_id: "tpd_1",
      telegram_message_id: null,
      content_hash: "stale",
      status: "failed",
      attempt_count: 1,
    }

    await publish()

    expect(calls).toContain("telegram:sendMessage")
    expect(calls.indexOf("reserve")).toBeLessThan(calls.indexOf("telegram:sendMessage"))
  })

  test("does not increment the attempt count twice on failure", async () => {
    sendFails = true
    await expect(publish()).rejects.toThrow()

    const failure = executions.find((execution) => classify(execution.sql) === "fail")
    expect(failure).toBeDefined()
    // The reservation already counted this attempt.
    expect(failure?.sql.toUpperCase()).not.toContain("ATTEMPT_COUNT = TELEGRAM_POST_DELIVERIES.ATTEMPT_COUNT + 1")
  })
})
