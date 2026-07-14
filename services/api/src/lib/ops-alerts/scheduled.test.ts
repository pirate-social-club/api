import { describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import { captureScheduledWarning } from "./scheduled"

describe("captureScheduledWarning", () => {
  test("honors an explicit structured warning count", async () => {
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

    await captureScheduledWarning(
      env,
      "HNS namespace ownership leases are approaching expiry without refresh",
      "hns_namespace_revalidation_lease_expiry",
      { count: 7, errors: 1, leasesApproachingExpiry: 7 },
      { urgency: "high" },
    )

    expect(sent[0]?.text).toContain("Count: 7")
  })

  test("derives count and community ids from scheduled summary details", async () => {
    const sent: Array<{ text?: string; subject?: string }> = []
    const env = {
      ENVIRONMENT: "staging",
      OPS_ALERT_EMAIL_FROM: "alerts@pirate.sc",
      OPS_ALERT_EMAIL_TO: "piratesocialclub@proton.me",
      OPS_ALERT_EMAIL: {
        send: async (message: { text?: string; subject?: string }) => {
          sent.push(message)
          return { messageId: "msg_test" }
        },
      },
    } as unknown as Env

    await captureScheduledWarning(
      env,
      "Post publish finalize reconciliation had community routing failures",
      "community_jobs_post_publish_finalize_reconciliation",
      {
        checked_communities: 78,
        failed_posts: 0,
        failed_communities: [
          { community_id: "cmt_b", error: "Community has no database routing entry" },
          { community_id: "cmt_a", error: "Community has no database routing entry" },
        ],
      },
      { urgency: "high" },
    )

    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe("[Pirate staging] Post publish finalize reconciliation had community routing failures")
    expect(sent[0]?.text).toContain("Count: 2")
    expect(sent[0]?.text).toContain("Communities: 2")
    expect(sent[0]?.text).toContain("- cmt_a: Community has no database routing entry")
    expect(sent[0]?.text).toContain("- cmt_b: Community has no database routing entry")
  })

  test("treats low urgency as low severity and dedupes it with the low bucket", async () => {
    const sent: Array<{ text?: string; subject?: string }> = []
    const kv = new Map<string, string>()
    const env = {
      ENVIRONMENT: "staging",
      OPS_ALERT_LOW_BUCKET_MS: String(24 * 60 * 60 * 1000),
      OPS_ALERT_EMAIL_FROM: "alerts@pirate.sc",
      OPS_ALERT_EMAIL_TO: "piratesocialclub@proton.me",
      OPS_ALERT_DEDUPE: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => {
          kv.set(key, value)
        },
      },
      OPS_ALERT_EMAIL: {
        send: async (message: { text?: string; subject?: string }) => {
          sent.push(message)
          return { messageId: "msg_test" }
        },
      },
    } as unknown as Env

    const extra = {
      checked_communities: 84,
      failed_posts: 0,
      failed_communities: [
        { community_id: "cmt_a", error: "Community has no database routing entry" },
      ],
    }

    await captureScheduledWarning(
      env,
      "Post publish finalize reconciliation had community routing failures",
      "community_jobs_post_publish_finalize_reconciliation",
      extra,
      { urgency: "low" },
    )
    await captureScheduledWarning(
      env,
      "Post publish finalize reconciliation had community routing failures",
      "community_jobs_post_publish_finalize_reconciliation",
      extra,
      { urgency: "low" },
    )

    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain("[LOW][staging] Post publish finalize reconciliation had community routing failures")
    expect([...kv.keys()][0]).toContain("scheduled_warning:community_jobs_post_publish_finalize_reconciliation:low")
  })

  test("delivers one actionable reward incident email per dedupe bucket", async () => {
    const sent: Array<{ text?: string; subject?: string }> = []
    const kv = new Map<string, string>()
    const env = {
      ENVIRONMENT: "staging",
      OPS_ALERT_EMAIL_FROM: "alerts@pirate.sc",
      OPS_ALERT_EMAIL_TO: "piratesocialclub@proton.me",
      OPS_ALERT_DEDUPE: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => { kv.set(key, value) },
      },
      OPS_ALERT_EMAIL: {
        send: async (message: { text?: string; subject?: string }) => {
          sent.push(message)
          return { messageId: "msg_reward_incident" }
        },
      },
    } as unknown as Env
    const extra = {
      incident_id: "rci_alert_test",
      campaign_id: "rcp_alert_test",
      incident_kind: "accounting_mismatch",
      reason: "campaign_accounting_counters_mismatch",
      stored_reserved_cents: "101",
      computed_reserved_cents: "100",
      reserved_delta_cents: "1",
    }

    await captureScheduledWarning(env, "Reward campaign integrity incident", "reward_campaign_integrity:rci_alert_test", extra, { urgency: "high" })
    await captureScheduledWarning(env, "Reward campaign integrity incident", "reward_campaign_integrity:rci_alert_test", extra, { urgency: "high" })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe("[Pirate staging] Reward campaign integrity incident")
    expect(sent[0]?.text).toContain("incident_id: rci_alert_test")
    expect(sent[0]?.text).toContain("campaign_id: rcp_alert_test")
    expect(sent[0]?.text).toContain("incident_kind: accounting_mismatch")
    expect(sent[0]?.text).toContain("stored_reserved_cents: 101")
    expect(sent[0]?.text).toContain("computed_reserved_cents: 100")
    expect(sent[0]?.text).toContain("reserved_delta_cents: 1")
  })
})
