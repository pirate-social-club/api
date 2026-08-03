import { afterEach, describe, expect, test } from "bun:test"

import { createControlPlaneTestClient } from "../../tests/helpers"
import type { Env } from "../../src/env"
import { resolveRewardNationalityBindingShadow } from "../../src/lib/rewards/reward-nationality-shadow-evaluator"
import { resolveActiveRewardIdentity } from "../../src/lib/verification/unique-human-eligibility"
import type { Client } from "../../src/lib/sql-client"
import {
  cleanupStagingRewardNationalityShadowIdentity,
  cleanupStagingRewardIdentity,
  seedStagingRewardNationalityShadowIdentity,
  seedStagingRewardIdentity,
  type StagingRewardNationalityShadowSnapshot,
  type StagingRewardIdentitySnapshot,
} from "./staging-reward-identity"

const NOW = "2026-07-14T12:00:00.000Z"
const USER_ID = "usr_reward_money_loop"
const ORIGINAL_CAPABILITIES = JSON.stringify({
  unique_human: { state: "unverified" },
  age_over_18: { state: "unverified" },
  minimum_age: { state: "unverified" },
  nationality: { state: "unverified" },
  gender: { state: "unverified" },
  wallet_score: { state: "unverified" },
})
const SHADOW_ENV = {
  REWARDS_NATIONALITY_SHADOW_WRITES_ENABLED: "true",
  REWARDS_NATIONALITY_SHADOW_IDENTITY_PROVIDER: "self",
} as Env

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function setup(options: { wallet?: boolean; verificationState?: "unverified" | "verified" } = {}) {
  const database = await createControlPlaneTestClient({ includeAllMigrations: true })
  cleanups.push(database.cleanup)
  const state = options.verificationState ?? "unverified"
  await database.client.execute({
    sql: `
      INSERT INTO users (
        user_id, primary_wallet_attachment_id, verification_state, capability_provider,
        verification_capabilities_json, verified_at, current_verification_session_id,
        created_at, updated_at
      ) VALUES (?1, NULL, ?2, ?3, ?4, ?5, NULL, ?6, ?6)
    `,
    args: [
      USER_ID,
      state,
      state === "verified" ? "very" : null,
      state === "verified"
        ? JSON.stringify({ unique_human: { state: "verified", provider: "very" } })
        : ORIGINAL_CAPABILITIES,
      state === "verified" ? NOW : null,
      "2026-07-14T11:00:00.000Z",
    ],
  })
  if (options.wallet !== false) {
    await database.client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized,
          wallet_address_display, source_provider, source_subject, attachment_kind,
          is_primary, status, attached_at, detached_at, created_at, updated_at
        ) VALUES (?1, ?2, 'eip155', ?3, ?3, 'staging_test', ?2, 'external', 1, 'active', ?4, NULL, ?4, ?4)
      `,
      args: ["wal_reward_money_loop", USER_ID, "0x1111111111111111111111111111111111111111", NOW],
    })
  }
  return database.client as unknown as Client
}

async function seed(client: Client): Promise<StagingRewardIdentitySnapshot> {
  let snapshot: StagingRewardIdentitySnapshot | null = null
  const result = await seedStagingRewardIdentity({
    client,
    userId: USER_ID,
    now: NOW,
    writeSnapshot: (value) => { snapshot = value },
  })
  expect(snapshot).toEqual(result)
  return result
}

async function seedNationalityShadow(
  client: Client,
  nationality: string | null,
): Promise<StagingRewardNationalityShadowSnapshot> {
  let snapshot: StagingRewardNationalityShadowSnapshot | null = null
  const result = await seedStagingRewardNationalityShadowIdentity({
    client,
    userId: USER_ID,
    nationality,
    now: NOW,
    writeSnapshot: (value) => { snapshot = value },
  })
  expect(snapshot).toEqual(result)
  return result
}

describe("staging reward identity projection", () => {
  test("seeds only the reward eligibility projection and restores the exact user snapshot", async () => {
    const client = await setup()
    const snapshot = await seed(client)

    const identity = await resolveActiveRewardIdentity(client, USER_ID, "very")
    expect(identity?.provider).toBe("very")
    expect(identity?.id).toMatch(/^rwi_[0-9a-f]{64}$/u)
    const seededUser = await client.execute({
      sql: "SELECT verification_state, capability_provider, verified_at FROM users WHERE user_id = ?1",
      args: [USER_ID],
    })
    expect(seededUser.rows[0]).toMatchObject({
      verification_state: "verified",
      capability_provider: "very",
      verified_at: NOW,
    })

    expect(await cleanupStagingRewardIdentity({ client, snapshot })).toBe("cleaned")
    const restored = await client.execute({
      sql: `
        SELECT verification_state, capability_provider, verification_capabilities_json,
          verified_at, current_verification_session_id, updated_at
        FROM users WHERE user_id = ?1
      `,
      args: [USER_ID],
    })
    expect(restored.rows[0]).toEqual({
      verification_state: snapshot.original_user.verification_state,
      capability_provider: snapshot.original_user.capability_provider,
      verification_capabilities_json: snapshot.original_user.verification_capabilities_json,
      verified_at: snapshot.original_user.verified_at,
      current_verification_session_id: snapshot.original_user.current_verification_session_id,
      updated_at: snapshot.original_user.updated_at,
    })
    expect(await cleanupStagingRewardIdentity({ client, snapshot })).toBe("already_clean")
  })

  test("rejects a user without an active EVM cashout wallet", async () => {
    const client = await setup({ wallet: false })
    await expect(seed(client)).rejects.toThrow("staging_reward_identity_active_evm_wallet_required")
  })

  test("rejects an actor that already has verification state", async () => {
    const client = await setup({ verificationState: "verified" })
    await expect(seed(client)).rejects.toThrow("staging_reward_identity_user_not_dedicated_unverified")
  })

  test("cleanup fails closed when another capability changed after seeding", async () => {
    const client = await setup()
    const snapshot = await seed(client)
    const user = await client.execute({
      sql: "SELECT verification_capabilities_json FROM users WHERE user_id = ?1",
      args: [USER_ID],
    })
    const capabilities = JSON.parse(String(user.rows[0]?.verification_capabilities_json))
    capabilities.wallet_score = { state: "verified", provider: "passport" }
    await client.execute({
      sql: "UPDATE users SET verification_capabilities_json = ?2, updated_at = ?3 WHERE user_id = ?1",
      args: [USER_ID, JSON.stringify(capabilities), "2026-07-14T12:05:00.000Z"],
    })

    await expect(cleanupStagingRewardIdentity({ client, snapshot })).rejects.toThrow(
      "staging_reward_identity_other_capabilities_changed",
    )
    const nullifiers = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM identity_nullifiers WHERE identity_nullifier_id = ?1",
      args: [snapshot.seed.identity_nullifier_id],
    })
    expect(Number(nullifiers.rows[0]?.count)).toBe(1)
  })

  test("seeds and exactly cleans up the Self nationality chain without changing reward eligibility", async () => {
    const client = await setup()
    const snapshot = await seedNationalityShadow(client, "VNM")

    expect(await resolveActiveRewardIdentity(client, USER_ID, "very")).toBeNull()
    const rows = await client.execute({
      sql: `
        SELECT n.provider, n.mechanism, b.status AS binding_status,
          a.capability_key, a.status AS attestation_status, a.value_json
        FROM identity_nullifiers n
        JOIN reward_identity_bindings b ON b.identity_nullifier_id = n.identity_nullifier_id
        JOIN user_attestations a ON a.source_identity_nullifier_id = n.identity_nullifier_id
        WHERE n.identity_nullifier_id = ?1
      `,
      args: [snapshot.seed.identity_nullifier_id],
    })
    expect(rows.rows[0]).toMatchObject({
      provider: "self",
      mechanism: "zk-nullifier",
      binding_status: "active",
      capability_key: "nationality",
      attestation_status: "accepted",
    })
    expect(JSON.parse(String(rows.rows[0]?.value_json))).toEqual({ nationality: "VNM" })
    expect(await resolveRewardNationalityBindingShadow({ env: SHADOW_ENV, client, userId: USER_ID })).toMatchObject({
      capability: "binding_preview",
      outcome: "resolved",
      retryability: "resolved",
      nationality: "VNM",
      identityNullifierId: snapshot.seed.identity_nullifier_id,
    })

    expect(await cleanupStagingRewardNationalityShadowIdentity({ client, snapshot })).toBe("cleaned")
    expect(await cleanupStagingRewardNationalityShadowIdentity({ client, snapshot })).toBe("already_clean")
    const leftovers = await client.execute({
      sql: `
        SELECT
          (SELECT COUNT(*) FROM identity_nullifiers WHERE identity_nullifier_id = ?1) AS nullifiers,
          (SELECT COUNT(*) FROM reward_identity_bindings WHERE reward_identity_binding_id = ?2) AS bindings,
          (SELECT COUNT(*) FROM user_attestations WHERE user_attestation_id = ?3) AS attestations,
          (SELECT COUNT(*) FROM verification_sessions WHERE verification_session_id = ?4) AS sessions
      `,
      args: [
        snapshot.seed.identity_nullifier_id,
        snapshot.seed.reward_identity_binding_id,
        snapshot.seed.user_attestation_id,
        snapshot.seed.verification_session_id,
      ],
    })
    expect(leftovers.rows[0]).toEqual({ nullifiers: 0, bindings: 0, attestations: 0, sessions: 0 })
  })

  test("seeds a bound Self identity without evidence for the retryable shadow path", async () => {
    const client = await setup({ wallet: false })
    const snapshot = await seedNationalityShadow(client, null)

    expect(snapshot.seed).toMatchObject({
      provider: "self",
      mechanism: "zk-nullifier",
      nationality: null,
      verification_session_id: null,
      user_attestation_id: null,
    })
    const rows = await client.execute({
      sql: `
        SELECT
          (SELECT COUNT(*) FROM identity_nullifiers WHERE identity_nullifier_id = ?1) AS nullifiers,
          (SELECT COUNT(*) FROM reward_identity_bindings WHERE reward_identity_binding_id = ?2) AS bindings,
          (SELECT COUNT(*) FROM user_attestations WHERE source_identity_nullifier_id = ?1) AS attestations
      `,
      args: [snapshot.seed.identity_nullifier_id, snapshot.seed.reward_identity_binding_id],
    })
    expect(rows.rows[0]).toEqual({ nullifiers: 1, bindings: 1, attestations: 0 })
    expect(await resolveRewardNationalityBindingShadow({ env: SHADOW_ENV, client, userId: USER_ID })).toMatchObject({
      capability: "binding_preview",
      outcome: "nationality_evidence_missing",
      retryability: "retryable",
      nationality: null,
      identityNullifierId: snapshot.seed.identity_nullifier_id,
    })
    expect(await cleanupStagingRewardNationalityShadowIdentity({ client, snapshot })).toBe("cleaned")
  })

  test("adds and removes only the Self shadow chain beside an existing Very reward identity", async () => {
    const client = await setup({ verificationState: "verified" })
    await client.execute({
      sql: `
        INSERT INTO identity_nullifiers (
          identity_nullifier_id, user_id, provider, mechanism, nullifier_hash,
          status, first_seen_at, created_at, updated_at
        ) VALUES ('nul_existing_very', ?1, 'very', 'palm-nullifier',
          'hash_existing_very', 'active', ?2, ?2, ?2)
      `,
      args: [USER_ID, NOW],
    })
    const before = await resolveActiveRewardIdentity(client, USER_ID, "very")
    const snapshot = await seedNationalityShadow(client, "CAN")

    expect(await resolveActiveRewardIdentity(client, USER_ID, "very")).toEqual(before)
    expect(await resolveRewardNationalityBindingShadow({ env: SHADOW_ENV, client, userId: USER_ID })).toMatchObject({
      outcome: "resolved",
      nationality: "CAN",
    })
    expect(await cleanupStagingRewardNationalityShadowIdentity({ client, snapshot })).toBe("cleaned")
    expect(await resolveActiveRewardIdentity(client, USER_ID, "very")).toEqual(before)
    const remaining = await client.execute({
      sql: "SELECT provider, mechanism, nullifier_hash FROM identity_nullifiers WHERE user_id = ?1",
      args: [USER_ID],
    })
    expect(remaining.rows).toEqual([{
      provider: "very",
      mechanism: "palm-nullifier",
      nullifier_hash: "hash_existing_very",
    }])
  })
})
