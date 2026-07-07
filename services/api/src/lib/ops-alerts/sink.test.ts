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
      BUILD_GIT_SHA: "1234567890abcdef",
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
    const text = String((sent[0] as { text?: unknown }).text)
    expect(text).toContain("[HIGH][staging] Ops alert smoke test")
    expect(text).toContain("Deploy: 1234567890ab")
    expect(text).toContain("details: {\"source\":\"test\"}")
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

  test("summarizes failed communities instead of dumping long JSON", async () => {
    const sent: Array<{ text?: string }> = []
    const env = {
      ENVIRONMENT: "staging",
      OPS_ALERT_EMAIL_FROM: "alerts@pirate.sc",
      OPS_ALERT_EMAIL_TO: "piratesocialclub@proton.me",
      OPS_ALERT_EMAIL: {
        send: async (message: { text?: string }) => {
          sent.push(message)
          return { messageId: "msg_test" }
        },
      },
    } as unknown as Env
    const failedCommunities = Array.from({ length: 7 }, (_, index) => ({
      community_id: `cmt_${index}`,
      error: "Community has no database routing entry",
    }))

    await sendOpsAlerts(env, [{
      key: "scheduled_warning:community_jobs_post_publish_finalize_reconciliation:high",
      severity: "high",
      title: "Post publish finalize reconciliation had community routing failures",
      count: 7,
      community_ids: failedCommunities.map((community) => community.community_id),
      details: {
        task: "community_jobs_post_publish_finalize_reconciliation",
        checked_communities: 78,
        failed_posts: 0,
        failed_communities: failedCommunities,
      },
    }])

    expect(sent[0]?.text).toContain("Count: 7")
    expect(sent[0]?.text).toContain("Communities: 7")
    expect(sent[0]?.text).toContain("failed_posts: 0")
    expect(sent[0]?.text).toContain("Failed communities:")
    expect(sent[0]?.text).toContain("- cmt_0: Community has no database routing entry")
    expect(sent[0]?.text).toContain("- +2 more")
    expect(sent[0]?.text).not.toContain("\"failed_communities\"")
  })
})
