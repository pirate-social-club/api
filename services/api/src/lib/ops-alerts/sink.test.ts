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
  test("keeps development alerts in logs even when an email binding is configured", async () => {
    let sends = 0
    const result = await sendOpsAlerts({
      ENVIRONMENT: "development",
      OPS_ALERT_EMAIL_FROM: "alerts@pirate.sc",
      OPS_ALERT_EMAIL_TO: "piratesocialclub@proton.me",
      OPS_ALERT_EMAIL: {
        send: async () => {
          sends += 1
          return { messageId: "should-not-send" }
        },
      },
    } as unknown as Env, [alert])

    expect(result).toEqual({
      delivered: true,
      sent: 0,
      sink: "log",
      providerMessageId: null,
    })
    expect(sends).toBe(0)
  })

  test("includes ownership and an actionable runbook for Story reconciliation", async () => {
    const sent: Array<{ text?: string }> = []
    await sendOpsAlerts({
      ENVIRONMENT: "staging",
      OPS_ALERT_EMAIL_FROM: "alerts@pirate.sc",
      OPS_ALERT_EMAIL_TO: "piratesocialclub@proton.me",
      OPS_ALERT_EMAIL: {
        send: async (message: { text?: string }) => {
          sent.push(message)
          return { messageId: "message-story" }
        },
      },
    } as unknown as Env, [{
      ...alert,
      key: "story_registration_reconciliation_required",
      title: "Story registration effects require transaction reconciliation",
    }])

    expect(sent[0]?.text).toContain("Owner: Story operations")
    expect(sent[0]?.text).toContain("Runbook: https://github.com/pirate-social-club/api/blob/main/services/api/docs/runbooks/story-registration-effect-resolution.md")
    expect(sent[0]?.text).toContain("never infer no-broadcast")
  })

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

    expect(result).toEqual({ delivered: true, sent: 1, sink: "email", providerMessageId: "msg_test" })
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

    expect(result).toEqual({ delivered: false, sent: 0, sink: "email", providerMessageId: null })
  })

  test("includes Story signer funding and explorer details in email summaries", async () => {
    const sent: Array<{ html?: string; text?: string }> = []
    const env = {
      ENVIRONMENT: "staging",
      OPS_ALERT_EMAIL_FROM: "alerts@pirate.sc",
      OPS_ALERT_EMAIL_TO: "piratesocialclub@proton.me",
      OPS_ALERT_EMAIL: {
        send: async (message: { html?: string; text?: string }) => {
          sent.push(message)
          return { messageId: "msg_test" }
        },
      },
    } as unknown as Env

    await sendOpsAlerts(env, [{
      key: "scheduled_warning:story_runtime_funding_watchdog:high",
      severity: "high",
      title: "Story signer story-settlement is below its funding floor",
      count: 1,
      community_ids: [],
      details: {
        task: "story_runtime_funding_watchdog",
        signer: "story-settlement",
        address: "0x526331ddA08972173C485b874956818E8a0b7D2F",
        explorer_url: "https://aeneid.storyscan.io/address/0x526331ddA08972173C485b874956818E8a0b7D2F",
        balance_ip: "0.147085117992178802",
        enforced_floor_ip: "0.25",
        target_balance_ip: "0.5",
        top_up_to_target_ip: "0.352914882007821198",
      },
    }])

    expect(sent[0]?.text).toContain("address: 0x526331ddA08972173C485b874956818E8a0b7D2F")
    expect(sent[0]?.text).toContain("explorer_url: https://aeneid.storyscan.io/address/")
    expect(sent[0]?.text).toContain("balance_ip: 0.147085117992178802")
    expect(sent[0]?.text).toContain("top_up_to_target_ip: 0.352914882007821198")
    expect(sent[0]?.html).toContain(
      '<a href="https://aeneid.storyscan.io/address/0x526331ddA08972173C485b874956818E8a0b7D2F">',
    )
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
