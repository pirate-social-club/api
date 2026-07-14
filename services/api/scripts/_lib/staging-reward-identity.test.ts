import { afterEach, describe, expect, test } from "bun:test"

import { createControlPlaneTestClient } from "../../tests/helpers"
import { resolveActiveRewardIdentity } from "../../src/lib/verification/unique-human-eligibility"
import type { Client } from "../../src/lib/sql-client"
import {
  cleanupStagingRewardIdentity,
  seedStagingRewardIdentity,
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

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function setup(options: { wallet?: boolean; verificationState?: "unverified" | "verified" } = {}) {
  const database = await createControlPlaneTestClient()
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
})

