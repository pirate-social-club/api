import { describe, expect, test } from "bun:test"
import {
  isWriteAllowedStatement,
  type ShardRpc,
  type ShardSqlStatement,
  type ShardResult,
  type ShardQueryResult,
} from "@pirate/api-shared"
import { makeCommunityD1Client } from "./community-d1-client"
import type { ResolvedCommunityBinding } from "./community-binding-resolver"
import { updateCommunityRulesOnClient } from "./community-rule-settings-service"
import { updateCommunityDonationPolicyOnClient } from "./community-donation-settings-service"
import { persistAssistantPolicyOnClient, type CommunityAssistantPolicy } from "./assistant-policy/service"
import { normalizeInputRules } from "./create/repository"
import { normalizeDonationPolicyMode } from "./create/update-validation"

// Buffer-safety regressions for the three community-settings write-tx seams the
// D1 write-tx audit flagged as "needs test only" (write-only today, but unguarded
// against a future edit reintroducing an in-tx read). Each seam opens its own
// transaction("write"); driven through the REAL makeCommunityD1Client buffering
// client + a fake shard applying the REAL isWriteAllowedStatement, commit fails if
// any SELECT/readback is buffered. Mirrors post-jobs / live-room publish guard
// tests. See [d1-buffered-write-tx-select-trap].

const COMMUNITY_ID = "cmt_pilot"
const NOW = "2026-06-22T00:00:00.000Z"

function bindingFor(communityId: string): ResolvedCommunityBinding {
  return {
    communityId,
    backend: "d1",
    provisioningState: "ready",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_PILOT",
    region: "enam",
    decommissionedAt: null,
  } as ResolvedCommunityBinding
}

function makeGuardedFakeShard() {
  const seen: ShardSqlStatement[] = []
  const shard = {
    async batchWrite(input: {
      statements: ShardSqlStatement[]
    }): Promise<ShardResult<ShardQueryResult[]>> {
      for (const statement of input.statements) {
        if (!isWriteAllowedStatement(statement.sql)) {
          return {
            ok: false,
            code: "shard_write_not_allowed",
            message: `Statement rejected by shard write guard: ${statement.sql}`,
          }
        }
      }
      seen.push(...input.statements)
      return { ok: true, value: input.statements.map(() => ({ rows: [] })) }
    },
  } as unknown as ShardRpc
  return { shard, seen }
}

function d1Client() {
  const { shard, seen } = makeGuardedFakeShard()
  return { client: makeCommunityD1Client(shard, bindingFor(COMMUNITY_ID)), seen }
}

const allWrites = (seen: ShardSqlStatement[]) =>
  seen.length > 0 && seen.every((s) => isWriteAllowedStatement(s.sql))

describe("community-settings write-tx seams (D1 buffer-safe)", () => {
  test("updateCommunityRulesOnClient: DELETE + INSERT + UPDATE commit with no buffered read", async () => {
    const { client, seen } = d1Client()
    await expect(
      updateCommunityRulesOnClient(client, {
        communityId: COMMUNITY_ID,
        rules: normalizeInputRules([
          { title: "No spam", body: "Do not spam the board.", report_reason: "spam", status: "active" },
        ]),
        now: NOW,
      }),
    ).resolves.toBeUndefined()

    expect(allWrites(seen)).toBe(true)
    expect(seen.some((s) => /delete\s+from\s+community_rules/i.test(s.sql))).toBe(true)
    expect(seen.some((s) => /insert\s+into\s+community_rules/i.test(s.sql))).toBe(true)
    expect(seen.some((s) => /update\s+communities/i.test(s.sql))).toBe(true)
  })

  test("updateCommunityDonationPolicyOnClient: partner upsert + community UPDATE commit with no buffered read", async () => {
    const { client, seen } = d1Client()
    await expect(
      updateCommunityDonationPolicyOnClient(client, {
        communityId: COMMUNITY_ID,
        donationPolicyMode: normalizeDonationPolicyMode("optional_creator_sidecar"),
        resolvedPartnerId: "dpt_1",
        partnerStatus: "active",
        donationPartner: {
          donation_partner_id: "dpt_1",
          display_name: "Ocean Cleanup",
          provider: "endaoment",
          provider_partner_ref: "end_123",
          payout_destination_ref: "0x00000000000000000000000000000000000000aa",
          image_url: "https://example.com/logo.png",
        } as never,
        nextSettings: {},
        now: NOW,
      }),
    ).resolves.toBeUndefined()

    expect(allWrites(seen)).toBe(true)
    const partnerInsert = seen.find((s) => /insert\s+into\s+donation_partners/i.test(s.sql))
    expect(partnerInsert).toBeTruthy()
    expect(partnerInsert?.args?.[3]).toBe("end_123")
    expect(partnerInsert?.args?.[4]).toBe("0x00000000000000000000000000000000000000aa")
    expect(seen.some((s) => /update\s+communities/i.test(s.sql))).toBe(true)
  })

  test("persistAssistantPolicyOnClient: policy upsert + prompt-revision insert commit with no buffered read", async () => {
    const { client, seen } = d1Client()
    const basePolicy = {
      enabled: true,
      displayName: "Harbor Guide",
      shortBio: "Helps with the community.",
      avatarRef: null,
      systemPrompt: "Be helpful.",
      defaultPrompt: "Ask me anything.",
      starterPrompts: ["What are the rules?"],
      selectedModelId: "mistralai/mistral-small-3.2-24b-instruct",
      contextMode: "live_sql",
      contextSources: {},
      maxContextThreads: 8,
      maxLookbackDays: 30,
      memoryEnabled: true,
      retentionMode: "per_user_private",
      retentionDays: 180,
      saveChatsToCommunityDb: true,
      actionMode: "answer_only",
      requireModeratorApprovalForWrites: true,
      perUserDailyMessageCap: 40,
      telegramPrivateAssistantEnabled: false,
      telegramPreviewEnabled: true,
      telegramPreviewDailyCap: 5,
      voiceMode: "off",
      sttProvider: "elevenlabs",
      sttModel: "scribe_v2",
      ttsProvider: "elevenlabs",
      ttsVoice: "",
      includeInSovereignExport: true,
    } as unknown as CommunityAssistantPolicy

    await expect(
      persistAssistantPolicyOnClient(client, {
        communityId: COMMUNITY_ID,
        actorUserId: "usr_admin",
        previousPolicy: basePolicy,
        // Different prompt → promptsChanged true → exercises the conditional revision INSERT.
        nextPolicy: { ...basePolicy, systemPrompt: "Be concise and helpful." },
        now: NOW,
      }),
    ).resolves.toBeUndefined()

    expect(allWrites(seen)).toBe(true)
    expect(seen.some((s) => /insert\s+into\s+community_assistant_policy/i.test(s.sql))).toBe(true)
    expect(seen.some((s) => /insert\s+into\s+community_assistant_prompt_revisions/i.test(s.sql))).toBe(true)
  })
})
