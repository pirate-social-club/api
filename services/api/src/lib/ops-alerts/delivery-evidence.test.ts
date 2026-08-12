import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"

import { createOpsAlertDeliveryEvidenceStore } from "./delivery-evidence"

describe("ops alert delivery evidence", () => {
  test("records attempting state before finalizing provider evidence", async () => {
    const client = createClient({ url: ":memory:" })
    await client.execute(`
      CREATE TABLE ops_alert_delivery_attempts (
        ops_alert_delivery_attempt_id TEXT PRIMARY KEY,
        alert_key TEXT NOT NULL,
        environment TEXT NOT NULL,
        severity TEXT NOT NULL,
        sink TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        alert_count INTEGER NOT NULL,
        sent_count INTEGER NOT NULL,
        bucket_start_ms INTEGER NOT NULL,
        provider_message_id TEXT,
        created_at TEXT NOT NULL
      )
    `)
    const store = createOpsAlertDeliveryEvidenceStore(client)
    await store.begin({
      attemptId: "oad_test",
      alertKey: "scheduled_warning:story_settlement_coordinator_synthetic:TEST:high",
      environment: "staging",
      severity: "high",
      alertCount: 1,
      bucketStartMs: 123,
    })
    expect((await client.execute(
      "SELECT delivery_status, sink, sent_count FROM ops_alert_delivery_attempts",
    )).rows[0]).toMatchObject({ delivery_status: "attempting", sink: "none", sent_count: 0 })

    await store.finish({
      attemptId: "oad_test",
      delivery: {
        delivered: true,
        sent: 1,
        sink: "email",
        providerMessageId: "msg_test",
      },
    })
    expect((await client.execute(
      "SELECT delivery_status, sink, sent_count, provider_message_id FROM ops_alert_delivery_attempts",
    )).rows[0]).toMatchObject({
      delivery_status: "delivered",
      sink: "email",
      sent_count: 1,
      provider_message_id: "msg_test",
    })
    client.close()
  })
})
