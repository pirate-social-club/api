import { randomBytes } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import { executeFirst } from "../../src/lib/db-helpers"
import { parseVerificationCapabilities } from "../../src/lib/auth/auth-serializers"
import { rowValue, stringOrNull } from "../../src/lib/sql-row"
import type { Client, QueryResultRow } from "../../src/lib/sql-client"
import { withTransaction } from "../../src/lib/transactions"

const SNAPSHOT_VERSION = 1 as const
const SEED_PROVIDER = "very" as const
const SEED_MECHANISM = "palm-nullifier" as const
const CAPABILITY_MECHANISM = "very_provider"

type NullableString = string | null

export type StagingRewardIdentitySnapshot = {
  version: typeof SNAPSHOT_VERSION
  purpose: "staging_reward_money_loop"
  user_id: string
  seeded_at: string
  seed: {
    identity_nullifier_id: string
    provider: typeof SEED_PROVIDER
    mechanism: typeof SEED_MECHANISM
    nullifier_hash: string
  }
  original_user: {
    verification_state: string
    capability_provider: NullableString
    verification_capabilities_json: string
    verified_at: NullableString
    current_verification_session_id: NullableString
    updated_at: string
  }
}

function requiredString(row: QueryResultRow, key: string): string {
  const value = stringOrNull(rowValue(row, key))
  if (!value) throw new Error(`staging_reward_identity_missing_${key}`)
  return value
}

function nullableString(row: QueryResultRow, key: string): NullableString {
  return stringOrNull(rowValue(row, key))
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value
  if (value && typeof value === "object") return JSON.stringify(value)
  throw new Error("staging_reward_identity_invalid_capabilities")
}

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`
}

function seedCapability(now: string) {
  return {
    state: "verified" as const,
    provider: SEED_PROVIDER,
    proof_type: "unique_human" as const,
    mechanism: CAPABILITY_MECHANISM,
    verified_at: Math.floor(Date.parse(now) / 1000),
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("staging_reward_identity_invalid_capabilities")
  }
  return parsed as Record<string, unknown>
}

function originalUser(row: QueryResultRow): StagingRewardIdentitySnapshot["original_user"] {
  return {
    verification_state: requiredString(row, "verification_state"),
    capability_provider: nullableString(row, "capability_provider"),
    verification_capabilities_json: jsonText(rowValue(row, "verification_capabilities_json")),
    verified_at: nullableString(row, "verified_at"),
    current_verification_session_id: nullableString(row, "current_verification_session_id"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function assertDedicatedUnverifiedUser(snapshot: StagingRewardIdentitySnapshot["original_user"]): void {
  const capabilities = parseVerificationCapabilities(snapshot.verification_capabilities_json)
  if (
    snapshot.verification_state !== "unverified"
    || snapshot.capability_provider !== null
    || snapshot.verified_at !== null
    || snapshot.current_verification_session_id !== null
    || capabilities.unique_human.state !== "unverified"
  ) {
    throw new Error("staging_reward_identity_user_not_dedicated_unverified")
  }
}

export async function seedStagingRewardIdentity(input: {
  client: Client
  userId: string
  now?: string
  rowLocks?: boolean
  writeSnapshot: (snapshot: StagingRewardIdentitySnapshot) => void
}): Promise<StagingRewardIdentitySnapshot> {
  const now = input.now ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(now))) throw new Error("staging_reward_identity_invalid_now")
  const identityNullifierId = makeId("nul_staging_reward")
  const nullifierHash = randomBytes(32).toString("hex")

  return withTransaction(input.client, "write", async (tx) => {
    const user = await executeFirst(tx, {
      sql: `
        SELECT verification_state, capability_provider, verification_capabilities_json,
          verified_at, current_verification_session_id, updated_at
        FROM users
        WHERE user_id = ?1
        LIMIT 1${input.rowLocks ? " FOR UPDATE" : ""}
      `,
      args: [input.userId],
    })
    if (!user) throw new Error("staging_reward_identity_user_not_found")
    const original = originalUser(user as QueryResultRow)
    assertDedicatedUnverifiedUser(original)

    const activeNullifier = await executeFirst(tx, {
      sql: "SELECT identity_nullifier_id FROM identity_nullifiers WHERE user_id = ?1 AND status = 'active' LIMIT 1",
      args: [input.userId],
    })
    if (activeNullifier) throw new Error("staging_reward_identity_active_nullifier_exists")

    const activeWallet = await executeFirst(tx, {
      sql: `
        SELECT wallet_attachment_id
        FROM wallet_attachments
        WHERE user_id = ?1 AND status = 'active' AND chain_namespace IN ('eip155', 'eip155:1')
        LIMIT 1
      `,
      args: [input.userId],
    })
    if (!activeWallet) throw new Error("staging_reward_identity_active_evm_wallet_required")

    const snapshot: StagingRewardIdentitySnapshot = {
      version: SNAPSHOT_VERSION,
      purpose: "staging_reward_money_loop",
      user_id: input.userId,
      seeded_at: now,
      seed: {
        identity_nullifier_id: identityNullifierId,
        provider: SEED_PROVIDER,
        mechanism: SEED_MECHANISM,
        nullifier_hash: nullifierHash,
      },
      original_user: original,
    }
    input.writeSnapshot(snapshot)

    const capabilities = parseJsonObject(original.verification_capabilities_json)
    capabilities.unique_human = seedCapability(now)
    const updated = await tx.execute({
      sql: `
        UPDATE users
        SET verification_state = 'verified', capability_provider = 'very',
          verification_capabilities_json = ?2, verified_at = ?3, updated_at = ?3
        WHERE user_id = ?1 AND verification_state = 'unverified'
          AND capability_provider IS NULL AND verified_at IS NULL
          AND current_verification_session_id IS NULL AND updated_at = ?4
      `,
      args: [input.userId, JSON.stringify(capabilities), now, original.updated_at],
    })
    if ((updated.rowsAffected ?? 0) !== 1) throw new Error("staging_reward_identity_user_changed_during_seed")

    await tx.execute({
      sql: `
        INSERT INTO identity_nullifiers (
          identity_nullifier_id, user_id, provider, mechanism, nullifier_hash,
          source_verification_session_id, source_user_attestation_id, status,
          first_seen_at, revoked_at, created_at, updated_at
        ) VALUES (?1, ?2, 'very', 'palm-nullifier', ?3, NULL, NULL, 'active', ?4, NULL, ?4, ?4)
      `,
      args: [identityNullifierId, input.userId, nullifierHash, now],
    })
    return snapshot
  })
}

function assertSnapshot(snapshot: StagingRewardIdentitySnapshot): void {
  if (
    snapshot.version !== SNAPSHOT_VERSION
    || snapshot.purpose !== "staging_reward_money_loop"
    || !snapshot.user_id
    || snapshot.seed.provider !== SEED_PROVIDER
    || snapshot.seed.mechanism !== SEED_MECHANISM
    || !/^nul_staging_reward_[0-9a-f]{32}$/u.test(snapshot.seed.identity_nullifier_id)
    || !/^[0-9a-f]{64}$/u.test(snapshot.seed.nullifier_hash)
  ) {
    throw new Error("staging_reward_identity_invalid_snapshot")
  }
}

function assertOnlySeededCapabilityChanged(
  currentRaw: string,
  snapshot: StagingRewardIdentitySnapshot,
): void {
  const current = parseJsonObject(currentRaw)
  const expectedOriginal = parseJsonObject(snapshot.original_user.verification_capabilities_json)
  const expectedSeed = seedCapability(snapshot.seeded_at)
  if (!isDeepStrictEqual(current.unique_human, expectedSeed)) {
    throw new Error("staging_reward_identity_seed_capability_changed")
  }
  if (Object.hasOwn(expectedOriginal, "unique_human")) current.unique_human = expectedOriginal.unique_human
  else delete current.unique_human
  if (!isDeepStrictEqual(current, expectedOriginal)) {
    throw new Error("staging_reward_identity_other_capabilities_changed")
  }
}

export async function cleanupStagingRewardIdentity(input: {
  client: Client
  snapshot: StagingRewardIdentitySnapshot
  rowLocks?: boolean
}): Promise<"cleaned" | "already_clean"> {
  assertSnapshot(input.snapshot)
  return withTransaction(input.client, "write", async (tx) => {
    const user = await executeFirst(tx, {
      sql: `
        SELECT verification_state, capability_provider, verification_capabilities_json,
          verified_at, current_verification_session_id, updated_at
        FROM users
        WHERE user_id = ?1
        LIMIT 1${input.rowLocks ? " FOR UPDATE" : ""}
      `,
      args: [input.snapshot.user_id],
    })
    if (!user) throw new Error("staging_reward_identity_user_not_found")
    const userRow = user as QueryResultRow

    const nullifier = await executeFirst(tx, {
      sql: `
        SELECT user_id, provider, mechanism, nullifier_hash, status
        FROM identity_nullifiers
        WHERE identity_nullifier_id = ?1
        LIMIT 1${input.rowLocks ? " FOR UPDATE" : ""}
      `,
      args: [input.snapshot.seed.identity_nullifier_id],
    })
    if (!nullifier) {
      if (!isDeepStrictEqual(originalUser(userRow), input.snapshot.original_user)) {
        throw new Error("staging_reward_identity_nullifier_missing_user_not_restored")
      }
      return "already_clean"
    }
    const nullifierRow = nullifier as QueryResultRow
    if (
      requiredString(nullifierRow, "user_id") !== input.snapshot.user_id
      || requiredString(nullifierRow, "provider") !== input.snapshot.seed.provider
      || requiredString(nullifierRow, "mechanism") !== input.snapshot.seed.mechanism
      || requiredString(nullifierRow, "nullifier_hash") !== input.snapshot.seed.nullifier_hash
      || requiredString(nullifierRow, "status") !== "active"
    ) {
      throw new Error("staging_reward_identity_seed_nullifier_changed")
    }

    const current = originalUser(userRow)
    if (
      current.verification_state !== "verified"
      || current.capability_provider !== SEED_PROVIDER
      || current.verified_at !== input.snapshot.seeded_at
      || current.current_verification_session_id !== input.snapshot.original_user.current_verification_session_id
    ) {
      throw new Error("staging_reward_identity_seed_user_changed")
    }
    assertOnlySeededCapabilityChanged(current.verification_capabilities_json, input.snapshot)

    const deleted = await tx.execute({
      sql: "DELETE FROM identity_nullifiers WHERE identity_nullifier_id = ?1 AND status = 'active'",
      args: [input.snapshot.seed.identity_nullifier_id],
    })
    if ((deleted.rowsAffected ?? 0) !== 1) throw new Error("staging_reward_identity_seed_nullifier_delete_failed")

    const restored = await tx.execute({
      sql: `
        UPDATE users
        SET verification_state = ?2, capability_provider = ?3,
          verification_capabilities_json = ?4, verified_at = ?5,
          current_verification_session_id = ?6, updated_at = ?7
        WHERE user_id = ?1 AND verification_state = 'verified'
          AND capability_provider = 'very' AND verified_at = ?8 AND updated_at = ?9
      `,
      args: [
        input.snapshot.user_id,
        input.snapshot.original_user.verification_state,
        input.snapshot.original_user.capability_provider,
        input.snapshot.original_user.verification_capabilities_json,
        input.snapshot.original_user.verified_at,
        input.snapshot.original_user.current_verification_session_id,
        input.snapshot.original_user.updated_at,
        input.snapshot.seeded_at,
        current.updated_at,
      ],
    })
    if ((restored.rowsAffected ?? 0) !== 1) throw new Error("staging_reward_identity_user_changed_during_cleanup")
    return "cleaned"
  })
}
