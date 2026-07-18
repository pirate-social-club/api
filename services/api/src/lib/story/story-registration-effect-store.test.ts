import { createClient } from "@libsql/client"
import { beforeEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  attestStoryRegistrationNotBroadcast,
  confirmStoryRegistrationEffect,
  failStoryRegistrationEffect,
  getStoryRegistrationEffect,
  reserveStoryRegistrationEffect,
  transitionReconciledStoryRegistrationToConfirmed,
  transitionRevertedStoryRegistrationToRetryable,
} from "./story-registration-effect-store"

const COMMUNITY_ID = "cmt_effect"
const ASSET_ID = "ast_effect"
const REQUEST = {
  communityId: COMMUNITY_ID,
  assetId: ASSET_ID,
  registrationKind: "original" as const,
  chainId: 1315,
  signerAddress: "0x9999999999999999999999999999999999999999",
  creatorWalletAddress: "0x1111111111111111111111111111111111111111",
  primaryContentHash: `0x${"22".repeat(32)}`,
  callDataHash: `0x${"44".repeat(32)}`,
  durableRequestJson: JSON.stringify({
    version: 1,
    creatorWalletAddress: "0x1111111111111111111111111111111111111111",
    royaltyShares: [{ recipient: "0xaaaa", percentage: 60 }, { recipient: "0xbbbb", percentage: 40 }],
    metadata: { createdAt: "2026-07-15T10:00:00.000Z", title: "Durable title" },
  }),
}

let client: ReturnType<typeof createClient>

beforeEach(async () => {
  client = createClient({ url: ":memory:" })
  await client.execute("CREATE TABLE communities (community_id TEXT PRIMARY KEY)")
  await client.execute({ sql: "INSERT INTO communities (community_id) VALUES (?1)", args: [COMMUNITY_ID] })
  for (const migrationName of [
    "1129_story_registration_effects.sql",
    "1130_story_registration_effect_request_identity.sql",
    "1139_story_registration_durable_request.sql",
  ]) {
    const migration = await readFile(
      new URL(`../../../test-fixtures/db/community-template/migrations/${migrationName}`, import.meta.url),
      "utf8",
    )
    await client.executeMultiple(migration)
  }
})

describe("Story registration effect journal", () => {
  test("is single-flight and replays the durable confirmed result", async () => {
    const first = await reserveStoryRegistrationEffect<{ storyIpId: string }>({
      client,
      ...REQUEST,
      now: "2026-07-15T10:00:00.000Z",
    })
    expect(first.kind).toBe("execute")
    if (first.kind !== "execute") throw new Error("expected execution reservation")

    await expect(reserveStoryRegistrationEffect({
      client,
      ...REQUEST,
      now: "2026-07-15T10:00:01.000Z",
    })).rejects.toThrow("story_registration_reconciliation_required:executing")

    await confirmStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      operationId: first.operationId,
      result: { storyIpId: "0xabc" },
      providerTxRef: `0x${"33".repeat(32)}`,
      now: "2026-07-15T10:00:02.000Z",
    })

    await expect(reserveStoryRegistrationEffect<{ storyIpId: string }>({
      client,
      ...REQUEST,
      now: "2026-07-15T10:00:03.000Z",
    })).resolves.toEqual({ kind: "confirmed", result: { storyIpId: "0xabc" } })
  })

  test("only a proven pre-broadcast failure can be reclaimed", async () => {
    const first = await reserveStoryRegistrationEffect({ client, ...REQUEST, now: "2026-07-15T10:00:00.000Z" })
    if (first.kind !== "execute") throw new Error("expected execution reservation")
    await failStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      operationId: first.operationId,
      reconciliationRequired: false,
      errorCode: "prebroadcast",
      now: "2026-07-15T10:00:01.000Z",
    })

    const retry = await reserveStoryRegistrationEffect({ client, ...REQUEST, now: "2026-07-15T10:00:02.000Z" })
    expect(retry.kind).toBe("execute")
    if (retry.kind !== "execute") throw new Error("expected retry reservation")
    expect(retry.operationId).not.toBe(first.operationId)
  })

  test("allows an operator-attested no-broadcast incident to be reclaimed without SQL", async () => {
    const first = await reserveStoryRegistrationEffect({ client, ...REQUEST, now: "2026-07-15T10:00:00.000Z" })
    if (first.kind !== "execute") throw new Error("expected execution reservation")
    await failStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      operationId: first.operationId,
      reconciliationRequired: true,
      errorCode: "story_registration_outcome_unknown",
      now: "2026-07-15T10:00:01.000Z",
    })

    await expect(attestStoryRegistrationNotBroadcast({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      expectedOperationId: first.operationId,
      reason: "checked signer history and provider traces",
      now: "2026-07-15T10:00:02.000Z",
    })).resolves.toMatchObject({
      operationId: first.operationId,
      status: "failed_prebroadcast",
      errorCode: "ops_confirmed_no_broadcast:checked signer history and provider traces",
    })

    await expect(getStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
    })).resolves.toMatchObject({ status: "failed_prebroadcast" })
    await expect(reserveStoryRegistrationEffect({
      client,
      ...REQUEST,
      now: "2026-07-15T10:00:03.000Z",
    })).resolves.toMatchObject({ kind: "execute" })
  })

  test("refuses an operator retry attestation when a provider transaction is known", async () => {
    const first = await reserveStoryRegistrationEffect({ client, ...REQUEST, now: "2026-07-15T10:00:00.000Z" })
    if (first.kind !== "execute") throw new Error("expected execution reservation")
    await failStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      operationId: first.operationId,
      reconciliationRequired: true,
      providerTxRef: `0x${"66".repeat(32)}`,
      errorCode: "story_registration_post_broadcast_error",
      now: "2026-07-15T10:00:01.000Z",
    })

    await expect(attestStoryRegistrationNotBroadcast({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      expectedOperationId: first.operationId,
      reason: "transaction is visible so this must not retry",
      now: "2026-07-15T10:00:02.000Z",
    })).rejects.toThrow("story_registration_resolution_conflict")
  })

  test("confirms a reconciled receipt only for the fenced operation and transaction", async () => {
    const first = await reserveStoryRegistrationEffect({ client, ...REQUEST, now: "2026-07-15T10:00:00.000Z" })
    if (first.kind !== "execute") throw new Error("expected execution reservation")
    const providerTxRef = `0x${"77".repeat(32)}`
    await failStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      operationId: first.operationId,
      reconciliationRequired: true,
      providerTxRef,
      errorCode: "story_registration_post_broadcast_error",
      now: "2026-07-15T10:00:01.000Z",
    })

    await expect(transitionReconciledStoryRegistrationToConfirmed({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      expectedOperationId: "sro_obsolete",
      providerTxRef,
      result: { storyIpId: "0xabc" },
      now: "2026-07-15T10:00:02.000Z",
    })).rejects.toThrow("story_registration_resolution_conflict")
    await expect(transitionReconciledStoryRegistrationToConfirmed({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      expectedOperationId: first.operationId,
      providerTxRef: `0x${"88".repeat(32)}`,
      result: { storyIpId: "0xabc" },
      now: "2026-07-15T10:00:02.000Z",
    })).rejects.toThrow("story_registration_resolution_conflict")
    await transitionReconciledStoryRegistrationToConfirmed({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      expectedOperationId: first.operationId,
      providerTxRef,
      result: { storyIpId: "0xabc" },
      now: "2026-07-15T10:00:03.000Z",
    })
    await expect(getStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
    })).resolves.toMatchObject({
      status: "confirmed",
      providerTxRef,
      resultJson: JSON.stringify({ storyIpId: "0xabc" }),
    })
  })

  test("retries only the fenced transaction after a verified revert and clears its old hash", async () => {
    const first = await reserveStoryRegistrationEffect({ client, ...REQUEST, now: "2026-07-15T10:00:00.000Z" })
    if (first.kind !== "execute") throw new Error("expected execution reservation")
    const providerTxRef = `0x${"99".repeat(32)}`
    await failStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      operationId: first.operationId,
      reconciliationRequired: true,
      providerTxRef,
      errorCode: "story_registration_post_broadcast_error",
      now: "2026-07-15T10:00:01.000Z",
    })
    await transitionRevertedStoryRegistrationToRetryable({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      expectedOperationId: first.operationId,
      providerTxRef,
      reason: "receipt reverted in canonical chain block",
      now: "2026-07-15T10:00:02.000Z",
    })
    await expect(getStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
    })).resolves.toMatchObject({
      status: "failed_prebroadcast",
      providerTxRef,
      errorCode: "ops_verified_reverted:receipt reverted in canonical chain block",
    })
    await expect(reserveStoryRegistrationEffect({
      client,
      ...REQUEST,
      now: "2026-07-15T10:00:03.000Z",
    })).resolves.toMatchObject({ kind: "execute" })
    await expect(getStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
    })).resolves.toMatchObject({ status: "executing", providerTxRef: null })
  })

  test("replays the first durable request instead of comparing recomputed retry inputs", async () => {
    const first = await reserveStoryRegistrationEffect({ client, ...REQUEST, now: "2026-07-15T10:00:00.000Z" })
    if (first.kind !== "execute") throw new Error("expected execution reservation")
    await failStoryRegistrationEffect({
      client,
      communityId: COMMUNITY_ID,
      assetId: ASSET_ID,
      operationId: first.operationId,
      reconciliationRequired: false,
      errorCode: "prebroadcast",
      now: "2026-07-15T10:00:00.500Z",
    })

    await expect(reserveStoryRegistrationEffect({
      client,
      ...REQUEST,
      creatorWalletAddress: "0x2222222222222222222222222222222222222222",
      callDataHash: `0x${"55".repeat(32)}`,
      durableRequestJson: JSON.stringify({
        metadata: { title: "Durable title", createdAt: "2026-07-15T10:00:01.000Z" },
        royaltyShares: [{ recipient: "0xbbbb", percentage: 40 }, { recipient: "0xaaaa", percentage: 60 }],
        creatorWalletAddress: "0x2222222222222222222222222222222222222222",
        version: 1,
      }),
      now: "2026-07-15T10:00:01.000Z",
    })).resolves.toMatchObject({
      kind: "execute",
      durableRequestJson: REQUEST.durableRequestJson,
    })
  })

  test("fails closed for an unconfirmed legacy row without a durable request", async () => {
    await client.execute({
      sql: `
        INSERT INTO story_registration_effects (
          story_registration_effect_id, community_id, asset_id, effect_key, operation_id,
          registration_kind, chain_id, signer_address, creator_wallet_address,
          primary_content_hash, call_data_hash, status, created_at, updated_at
        ) VALUES ('sre_legacy', ?1, ?2, ?3, 'sro_legacy', 'original', 1315, ?4, ?5, ?6, ?7,
          'failed_prebroadcast', ?8, ?8)
      `,
      args: [
        COMMUNITY_ID, ASSET_ID, `story_registration:${COMMUNITY_ID}:${ASSET_ID}`,
        REQUEST.signerAddress, REQUEST.creatorWalletAddress, REQUEST.primaryContentHash,
        REQUEST.callDataHash, "2026-07-15T10:00:00.000Z",
      ],
    })

    await expect(reserveStoryRegistrationEffect({
      client,
      ...REQUEST,
      now: "2026-07-15T10:00:01.000Z",
    })).rejects.toThrow("story_registration_legacy_request_reconciliation_required")
  })

  test("still replays a confirmed legacy result without inventing a request", async () => {
    const result = { storyIpId: "0xabc" }
    await client.execute({
      sql: `
        INSERT INTO story_registration_effects (
          story_registration_effect_id, community_id, asset_id, effect_key, operation_id,
          registration_kind, chain_id, signer_address, creator_wallet_address,
          primary_content_hash, call_data_hash, status, result_json, created_at, updated_at, confirmed_at
        ) VALUES ('sre_legacy_confirmed', ?1, ?2, ?3, 'sro_legacy_confirmed', 'original', 1315,
          ?4, ?5, ?6, ?7, 'confirmed', ?8, ?9, ?9, ?9)
      `,
      args: [
        COMMUNITY_ID, ASSET_ID, `story_registration:${COMMUNITY_ID}:${ASSET_ID}`,
        REQUEST.signerAddress, REQUEST.creatorWalletAddress, REQUEST.primaryContentHash,
        REQUEST.callDataHash, JSON.stringify(result), "2026-07-15T10:00:00.000Z",
      ],
    })

    await expect(reserveStoryRegistrationEffect({
      client,
      ...REQUEST,
      durableRequestJson: null,
      now: "2026-07-15T10:00:01.000Z",
    })).resolves.toEqual({ kind: "confirmed", result })
  })
})
