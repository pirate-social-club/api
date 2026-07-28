import { describe, expect, test } from "bun:test"

import type {
  Client,
  InStatement,
  QueryResult,
  Transaction,
} from "../../src/lib/sql-client"
import { seedRehearsalBaselineFixture } from "./baseline-fixture"

function fakeClient() {
  const statements: InStatement[] = []
  let committed = false
  const transaction: Transaction = {
    async execute(statement): Promise<QueryResult> {
      const normalized = typeof statement === "string" ? { sql: statement } : statement
      statements.push(normalized)
      if (normalized.sql.includes("FROM users u")) {
        return {
          rows: [{
            verification_state: "verified",
            verification_capabilities_json: { unique_human: { state: "verified" } },
            recipient_address: "0xCc4049cEd4ff4C3CA25F7e32eDb8c69dEA4bB12f",
            identity_nullifier_id: "nul_staging_reward_57b96359bf944f2a82b945d5f371dafb",
          }],
        }
      }
      if (normalized.sql.includes("FROM reward_campaigns")) {
        return {
          rows: [{
            rewarder_user_id: "usr_eb47ab813754497d8f107ca01d762bc9",
            community_id: "cmt_304e8a0f7ed84b268b05abdca364f5bf",
            post_id: "pst_54b21cd6432f4c9997ef2535d02fa4fe",
            song_artifact_bundle_id: "sab_92a6f8e441054f0eac7b1459b6935867",
            song_owner_user_id: "usr_1d1c30d1387644f6b7579b3507c062c8",
            eligible_activity: "karaoke",
            platform_fee_bps: 0,
            min_score_bps: 7000,
          }],
        }
      }
      return { rows: [], rowsAffected: 1 }
    },
    async batch(): Promise<QueryResult[]> {
      throw new Error("unexpected batch")
    },
    async commit() {
      committed = true
    },
    async rollback() {},
    close() {},
  }
  const client: Client = {
    async execute(): Promise<QueryResult> {
      throw new Error("expected transaction")
    },
    async batch(): Promise<QueryResult[]> {
      throw new Error("expected transaction")
    },
    async transaction() {
      return transaction
    },
  }
  return { client, statements, committed: () => committed }
}

describe("seedRehearsalBaselineFixture", () => {
  test("creates a campaign-backed 50-cent settlement fixture atomically", async () => {
    const fake = fakeClient()
    const fixture = await seedRehearsalBaselineFixture({
      client: fake.client,
      userId: "usr_eb47ab813754497d8f107ca01d762bc9",
      sourceCampaignId: "rcp_2bc3bed1f2114992b3bbd2cff5e71684",
      amountCents: 50,
      now: "2026-07-28T06:00:00.000Z",
    })

    expect(fake.committed()).toBe(true)
    expect(fixture).toMatchObject({
      version: 1,
      purpose: "rewards_vault_rehearsal_baseline",
      userId: "usr_eb47ab813754497d8f107ca01d762bc9",
      amountCents: 50,
      recipientAddress: "0xCc4049cEd4ff4C3CA25F7e32eDb8c69dEA4bB12f",
      sourceCampaignId: "rcp_2bc3bed1f2114992b3bbd2cff5e71684",
      qualificationPolicyVersion: "rehearsal_fixture_v1",
      scope: "settlement_path_only",
    })
    expect(fixture.campaignId).toMatch(/^rcp_[0-9a-f]{32}$/)
    expect(fixture.reservationId).toMatch(/^rcr_[0-9a-f]{32}$/)
    expect(fixture.rewardEventId).toMatch(/^rew_[0-9a-f]{32}$/)
    expect(fake.statements.some(({ sql }) => sql.includes("INSERT INTO reward_campaigns"))).toBe(true)
    expect(fake.statements.some(({ sql }) => sql.includes("INSERT INTO reward_events"))).toBe(true)
    expect(fake.statements.some(({ sql }) => sql.includes("UPDATE reward_campaign_reservations"))).toBe(true)
  })

  test("rejects malformed targets before opening a transaction", async () => {
    const fake = fakeClient()
    await expect(seedRehearsalBaselineFixture({
      client: fake.client,
      userId: "not-a-user",
      sourceCampaignId: "rcp_2bc3bed1f2114992b3bbd2cff5e71684",
      amountCents: 50,
    })).rejects.toThrow("baseline_fixture_invalid_user_id")
    expect(fake.statements).toHaveLength(0)
  })
})
