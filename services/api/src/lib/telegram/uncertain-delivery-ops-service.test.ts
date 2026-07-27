import { beforeEach, describe, expect, test } from "bun:test"
import {
  countUncertainDeliveries,
  listUncertainDeliveries,
  resolveUncertainDelivery,
  revertRetryAuthorization,
} from "./uncertain-delivery-ops-service"

// A fake control plane that records statements and lets each test decide how
// many rows the CAS updates — which is the whole mechanism under test.
type Execution = { sql: string; args: unknown[] }

let executions: Execution[] = []
let updateRows: unknown[] = []
let selectRows: unknown[] = []

function client() {
  return {
    execute: async ({ sql, args }: { sql: string; args: unknown[] }) => {
      executions.push({ sql, args })
      const text = sql.trim().toUpperCase()
      if (text.startsWith("SELECT COUNT")) return { rows: [{ uncertain_count: 3 }] }
      if (text.startsWith("SELECT")) return { rows: selectRows }
      return { rows: updateRows }
    },
  }
}

function lastSql(): string {
  return executions[executions.length - 1]?.sql.replace(/\s+/gu, " ").trim() ?? ""
}

describe("uncertain delivery listing", () => {
  beforeEach(() => {
    executions = []
    updateRows = []
    selectRows = []
  })

  test("only ever lists rows in the uncertain state", async () => {
    await listUncertainDeliveries({ client: client() })
    expect(lastSql()).toContain("status = 'uncertain'")
  })

  test("filters by community, destination and age together", async () => {
    await listUncertainDeliveries({
      client: client(),
      filters: { communityId: "cmt_1", destinationId: "tcd_1", olderThanMinutes: 30 },
    })
    const sql = lastSql()
    expect(sql).toContain("community_id = ?1")
    expect(sql).toContain("telegram_channel_destination_id = ?2")
    expect(sql).toContain("updated_at <= ?3")
  })

  test("rejects a negative age filter rather than silently ignoring it", async () => {
    await expect(listUncertainDeliveries({
      client: client(),
      filters: { olderThanMinutes: -5 },
    })).rejects.toThrow(/non-negative/u)
  })

  test("caps the page size", async () => {
    await listUncertainDeliveries({ client: client(), limit: 5000 })
    // Limit is the last bound argument.
    expect(executions[0]?.args.at(-1)).toBe(100)
  })

  test("does not expose the raw Telegram chat id", async () => {
    selectRows = [{
      telegram_post_delivery_id: "tpd_1",
      community_id: "cmt_1",
      telegram_channel_destination_id: "tcd_1",
      post_id: "pst_1",
      attempt_count: 2,
      updated_at: "2026-07-27T00:00:00.000Z",
      last_error: "boom",
      telegram_message_id: null,
      telegram_chat_id: "-1001234567890",
    }]
    const [item] = await listUncertainDeliveries({ client: client() })
    expect(item).toBeDefined()
    expect(JSON.stringify(item)).not.toContain("-1001234567890")
    expect(Object.keys(item as object)).not.toContain("telegram_chat_id")
  })

  test("count uses the same predicate as the list", async () => {
    await countUncertainDeliveries({ client: client(), filters: { communityId: "cmt_1" } })
    const sql = lastSql()
    expect(sql).toContain("status = 'uncertain'")
    expect(sql).toContain("community_id = ?1")
  })
})

describe("uncertain delivery resolution", () => {
  beforeEach(() => {
    executions = []
    updateRows = []
    selectRows = []
  })

  test("marked_delivered requires evidence", async () => {
    await expect(resolveUncertainDelivery({
      client: client(),
      deliveryId: "tpd_1",
      action: "marked_delivered",
      actorUserId: "usr_1",
    })).rejects.toThrow(/telegram_message_id or operator_confirmed/u);
    // Nothing was written.
    expect(executions).toHaveLength(0)
  })

  test("marked_delivered accepts a message id and records the audit", async () => {
    updateRows = [{ telegram_post_delivery_id: "tpd_1" }]
    const outcome = await resolveUncertainDelivery({
      client: client(),
      deliveryId: "tpd_1",
      action: "marked_delivered",
      actorUserId: "usr_1",
      telegramMessageId: 42,
      reason: "seen in channel",
    })
    expect(outcome.applied).toBe(true)
    const sql = lastSql()
    expect(sql).toContain("status = 'delivered'")
    expect(sql).toContain("resolution_action = 'marked_delivered'")
    // CAS: the write only lands while the row is still uncertain.
    expect(sql).toContain("AND status = 'uncertain'")
    expect(executions[0]?.args).toContain("usr_1")
    expect(executions[0]?.args).toContain("seen in channel")
  })

  test("marked_delivered accepts explicit operator confirmation without a message id", async () => {
    updateRows = [{ telegram_post_delivery_id: "tpd_1" }]
    const outcome = await resolveUncertainDelivery({
      client: client(),
      deliveryId: "tpd_1",
      action: "marked_delivered",
      actorUserId: "usr_1",
      operatorConfirmed: true,
    })
    expect(outcome.applied).toBe(true)
  })

  test("a repeated resolution is a no-op, not a second action", async () => {
    updateRows = []
    const outcome = await resolveUncertainDelivery({
      client: client(),
      deliveryId: "tpd_1",
      action: "marked_delivered",
      actorUserId: "usr_1",
      operatorConfirmed: true,
    })
    // The CAS matched nothing because the row is no longer uncertain.
    expect(outcome.applied).toBe(false)
  })

  test("retry_authorized records the authorization and returns the row to pending", async () => {
    updateRows = [{ community_id: "cmt_1", post_id: "pst_1" }]
    const outcome = await resolveUncertainDelivery({
      client: client(),
      deliveryId: "tpd_1",
      action: "retry_authorized",
      actorUserId: "usr_1",
    })
    expect(outcome.applied).toBe(true)
    const sql = lastSql()
    expect(sql).toContain("status = 'pending'")
    expect(sql).toContain("resolution_action = 'retry_authorized'")
    expect(sql).toContain("AND status = 'uncertain'")
  })

  test("a repeated retry authorization does not re-authorize", async () => {
    updateRows = []
    const outcome = await resolveUncertainDelivery({
      client: client(),
      deliveryId: "tpd_1",
      action: "retry_authorized",
      actorUserId: "usr_1",
    })
    expect(outcome.applied).toBe(false)
    // retry_enqueued is never set by the service; only the route enqueues, and
    // only when applied is true.
    expect(outcome.retry_enqueued).toBe(false)
  })

  test("an empty operator identity is refused", async () => {
    await expect(resolveUncertainDelivery({
      client: client(),
      deliveryId: "tpd_1",
      action: "retry_authorized",
      actorUserId: "   ",
    })).rejects.toThrow(/operator identity/u)
  })
})

describe("retry authorization rollback", () => {
  beforeEach(() => {
    executions = []
    updateRows = []
  })

  test("returns the row to uncertain so it stays listed and re-resolvable", async () => {
    updateRows = [{ telegram_post_delivery_id: "tpd_1" }]
    const reverted = await revertRetryAuthorization({
      client: client(),
      deliveryId: "tpd_1",
      note: "enqueue failed",
    })
    expect(reverted).toBe(true)
    const sql = lastSql()
    expect(sql).toContain("status = 'uncertain'")
    expect(sql).toContain("resolution_action = NULL")
    // Guarded on exactly the state the authorization created, so it cannot
    // clobber a concurrent resolution or a retry that actually started.
    expect(sql).toContain("AND status = 'pending'")
    expect(sql).toContain("AND resolution_action = 'retry_authorized'")
  })

  test("reports false when there was nothing to roll back", async () => {
    updateRows = []
    expect(await revertRetryAuthorization({
      client: client(),
      deliveryId: "tpd_1",
      note: "enqueue failed",
    })).toBe(false)
  })
})
