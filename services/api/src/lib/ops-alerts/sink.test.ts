import { describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import { sendOpsAlerts } from "./sink"
import type { OpsAlert } from "./types"

const alert: OpsAlert = {
  key: "scheduled_warning:ops_alert_smoke_test:high",
  severity: "high",
  title: "Ops alert smoke test",
  count: 1,
  community_ids: [],
  details: { source: "test" },
}

describe("sendOpsAlerts", () => {
  test("sends configured alerts through the email binding", async () => {
    const sent: unknown[] = []
    const env = {
      ENVIRONMENT: "staging",
      OPS_ALERT_EMAIL_FROM: "alerts@pirate.sc",
      OPS_ALERT_EMAIL_FROM_NAME: "Pirate Ops",
      OPS_ALERT_EMAIL_TO: "piratesocialclub@proton.me",
      OPS_ALERT_EMAIL: {
        send: async (message: unknown) => {
          sent.push(message)
          return { messageId: "msg_test" }
        },
      },
    } as unknown as Env

    const result = await sendOpsAlerts(env, [alert])

    expect(result).toEqual({ delivered: true, sent: 1, sink: "email" })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      to: "piratesocialclub@proton.me",
      from: { email: "alerts@pirate.sc", name: "Pirate Ops" },
      subject: "[Pirate staging] Ops alert smoke test",
    })
  })

  test("does not mark delivery successful when email send throws", async () => {
    const env = {
      ENVIRONMENT: "staging",
      OPS_ALERT_EMAIL_FROM: "alerts@pirate.sc",
      OPS_ALERT_EMAIL_TO: "piratesocialclub@proton.me",
      OPS_ALERT_EMAIL: {
        send: async () => {
          throw new Error("E_DELIVERY_FAILED")
        },
      },
    } as unknown as Env

    const result = await sendOpsAlerts(env, [alert])

    expect(result).toEqual({ delivered: false, sent: 0, sink: "email" })
  })
})
