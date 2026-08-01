import { afterEach, describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import type { Client } from "../sql-client"
import { createControlPlaneTestClient } from "../../../tests/helpers"
import {
  getRewardIdentityBinding,
  isActiveRewardIdentityBindingUniqueConflict,
  selectRewardIdentityBinding,
  supersedeRewardIdentityBindingsForNullifier,
} from "./reward-identity-binding-service"

const NOW = "2026-08-01T10:00:00.000Z"
const SELF_ENV = { REWARDS_IDENTITY_PROVIDER: "self" } as Env
const VERY_ENV = { REWARDS_IDENTITY_PROVIDER: "very" } as Env

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

async function setup(): Promise<Client> {
  const result = await createControlPlaneTestClient({ includeAllMigrations: true })
  cleanup = result.cleanup
  await result.client.execute({
    sql: `
      INSERT INTO users (
        user_id, primary_wallet_attachment_id, verification_state, capability_provider,
        verification_capabilities_json, verified_at, current_verification_session_id, created_at, updated_at
      ) VALUES (?1, NULL, 'verified', 'zkpass', ?2, ?3, NULL, ?3, ?3)
    `,
    // Deliberately contradictory account projection: selection must only use
    // nullifier-scoped Self evidence, never this ZKPassport-written slot.
    args: ["usr_reward_binding", JSON.stringify({ nationality: { state: "verified", value: "VNM", provider: "zkpass" } }), NOW],
  })
  return result.client
}

async function seedDocument(
  client: Client,
  input: { id: string; nationality: string; provider?: "self" | "very"; status?: "active" | "revoked"; attestationId?: string; expiresAt?: string | null },
): Promise<void> {
  const provider = input.provider ?? "self"
  await client.execute({
    sql: `
      INSERT INTO identity_nullifiers (
        identity_nullifier_id, user_id, provider, mechanism, nullifier_hash,
        source_verification_session_id, source_user_attestation_id, status,
        first_seen_at, revoked_at, created_at, updated_at
      ) VALUES (?1, 'usr_reward_binding', ?2, ?3, ?4, NULL, NULL, ?5, ?6, NULL, ?6, ?6)
    `,
    args: [input.id, provider, provider === "self" ? "zk-nullifier" : "palm-nullifier", `hash_${input.id}`, input.status ?? "active", NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO user_attestations (
        user_attestation_id, user_id, source_verification_session_id, provider, attestation_type,
        capability_key, status, value_json, verified_at, expires_at, revoked_at, created_at, updated_at,
        source_identity_nullifier_id
      ) VALUES (?1, 'usr_reward_binding', NULL, ?2, 'nationality', 'nationality', 'accepted', ?3, ?4, ?5, NULL, ?4, ?4, ?6)
    `,
    args: [input.attestationId ?? `att_${input.id}`, provider, JSON.stringify({ nationality: input.nationality }), NOW, input.expiresAt ?? null, input.id],
  })
}

describe("reward identity document selection", () => {
  test("selects only active Self nationality evidence bound to the exact nullifier", async () => {
    const client = await setup()
    await seedDocument(client, { id: "nul_self_a", nationality: "USA" })
    await seedDocument(client, { id: "nul_very", nationality: "VNM", provider: "very" })

    const before = await getRewardIdentityBinding({ env: SELF_ENV, client, userId: "usr_reward_binding", now: NOW })
    expect(before.capability).toBe("selection_required")
    expect(before.selectable_documents.map((document) => document.nationality)).toEqual(["USA"])

    const selected = await selectRewardIdentityBinding({
      env: SELF_ENV,
      client,
      userId: "usr_reward_binding",
      identityNullifierId: "nul_self_a",
      now: NOW,
    })
    expect(selected.capability).toBe("selected")
    expect(selected.active_binding?.nationality).toBe("USA")
    expect(selected.active_binding?.identity_nullifier_id).toBe("nul_self_a")
  })

  test("atomically supersedes the old binding when the user reselects", async () => {
    const client = await setup()
    await seedDocument(client, { id: "nul_self_a", nationality: "USA" })
    await seedDocument(client, { id: "nul_self_b", nationality: "CAN" })
    await selectRewardIdentityBinding({ env: SELF_ENV, client, userId: "usr_reward_binding", identityNullifierId: "nul_self_a", now: NOW })

    const selected = await selectRewardIdentityBinding({
      env: SELF_ENV,
      client,
      userId: "usr_reward_binding",
      identityNullifierId: "nul_self_b",
      now: "2026-08-01T11:00:00.000Z",
    })
    expect(selected.active_binding?.identity_nullifier_id).toBe("nul_self_b")
    const rows = await client.execute({
      sql: "SELECT identity_nullifier_id, status FROM reward_identity_bindings WHERE user_id = 'usr_reward_binding' ORDER BY selected_at",
    })
    expect(rows.rows).toEqual([
      { identity_nullifier_id: "nul_self_a", status: "superseded" },
      { identity_nullifier_id: "nul_self_b", status: "active" },
    ])
  })

  test("keeps an active binding valid after evidence expiry without offering stale evidence for selection", async () => {
    const client = await setup()
    await seedDocument(client, { id: "nul_expiring", nationality: "USA", expiresAt: "2026-08-02T10:00:00.000Z" })
    await selectRewardIdentityBinding({ env: SELF_ENV, client, userId: "usr_reward_binding", identityNullifierId: "nul_expiring", now: NOW })

    const afterExpiry = await getRewardIdentityBinding({
      env: SELF_ENV,
      client,
      userId: "usr_reward_binding",
      now: "2026-09-02T10:00:00.000Z",
    })
    expect(afterExpiry.capability).toBe("selected")
    expect(afterExpiry.active_binding?.identity_nullifier_id).toBe("nul_expiring")
    expect(afterExpiry.selectable_documents).toEqual([])
  })

  test("fails closed on conflicting nationality evidence for one document", async () => {
    const client = await setup()
    await seedDocument(client, { id: "nul_conflict", nationality: "USA" })
    await client.execute({
      sql: `
        INSERT INTO user_attestations (
          user_attestation_id, user_id, provider, attestation_type, capability_key, status,
          value_json, verified_at, created_at, updated_at, source_identity_nullifier_id
        ) VALUES ('att_conflict_2', 'usr_reward_binding', 'self', 'nationality', 'nationality',
          'accepted', ?1, ?2, ?2, ?2, 'nul_conflict')
      `,
      args: [JSON.stringify({ nationality: "CAN" }), NOW],
    })

    const response = await getRewardIdentityBinding({ env: SELF_ENV, client, userId: "usr_reward_binding", now: NOW })
    expect(response.selectable_documents).toEqual([])
    await expect(selectRewardIdentityBinding({
      env: SELF_ENV,
      client,
      userId: "usr_reward_binding",
      identityNullifierId: "nul_conflict",
      now: NOW,
    })).rejects.toMatchObject({ code: "reward_identity_document_ineligible" })
  })

  test("marks Very unavailable instead of creating a permanently pending selection", async () => {
    const client = await setup()
    await seedDocument(client, { id: "nul_self_a", nationality: "USA" })
    expect(await getRewardIdentityBinding({ env: VERY_ENV, client, userId: "usr_reward_binding", now: NOW })).toEqual({
      capability: "unavailable",
      provider: "very",
      active_binding: null,
      selectable_documents: [],
    })
    await expect(selectRewardIdentityBinding({
      env: VERY_ENV,
      client,
      userId: "usr_reward_binding",
      identityNullifierId: "nul_self_a",
      now: NOW,
    })).rejects.toMatchObject({ code: "reward_identity_provider_unsupported" })
  })

  test("a revoked document is no longer selected and its binding can be superseded", async () => {
    const client = await setup()
    await seedDocument(client, { id: "nul_self_a", nationality: "USA" })
    await selectRewardIdentityBinding({ env: SELF_ENV, client, userId: "usr_reward_binding", identityNullifierId: "nul_self_a", now: NOW })
    await client.execute("UPDATE identity_nullifiers SET status = 'revoked', revoked_at = '2026-08-01T11:00:00.000Z' WHERE identity_nullifier_id = 'nul_self_a'")

    const response = await getRewardIdentityBinding({ env: SELF_ENV, client, userId: "usr_reward_binding", now: "2026-08-01T11:00:00.000Z" })
    expect(response.capability).toBe("selection_required")
    expect(response.active_binding).toBeNull()
    expect(await supersedeRewardIdentityBindingsForNullifier({
      client,
      identityNullifierId: "nul_self_a",
      now: "2026-08-01T11:00:00.000Z",
    })).toBe(1)
  })

  test("classifies only unique violations for the active-binding constraint and follows causes", () => {
    const conflict = Object.assign(new Error('duplicate key value violates unique constraint "idx_reward_identity_bindings_user_active"'), {
      code: "23505",
      constraint: "idx_reward_identity_bindings_user_active",
    })
    expect(isActiveRewardIdentityBindingUniqueConflict(conflict)).toBe(true)
    expect(isActiveRewardIdentityBindingUniqueConflict(Object.assign(
      new Error("UNIQUE constraint failed: reward_identity_bindings.user_id"),
      { code: "SQLITE_CONSTRAINT_UNIQUE" },
    ))).toBe(true)
    expect(isActiveRewardIdentityBindingUniqueConflict(new Error("index idx_reward_identity_bindings_user_active unavailable"))).toBe(false)
    expect(isActiveRewardIdentityBindingUniqueConflict(new Error("outer", { cause: conflict }))).toBe(true)
  })
})
