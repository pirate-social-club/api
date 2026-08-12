import { executeFirst } from "../db-helpers"
import type { InStatement, QueryResult } from "../sql-client"
import { rowValue, stringOrNull } from "../sql-row"
import { parseVerificationCapabilities } from "../auth/auth-serializers"
import { applyLazyCapabilityExpiry, buildDefaultVerificationCapabilities } from "./verification-capabilities"

/** Exact match for the reward_campaigns DB CHECK; order is cashout selection precedence. */
export const SUPPORTED_REWARD_IDENTITY_PROVIDERS = ["self", "zkpassport", "very"] as const
export type RewardIdentityProvider = typeof SUPPORTED_REWARD_IDENTITY_PROVIDERS[number]

export type ActiveRewardIdentity = {
  id: string
  provider: RewardIdentityProvider
}

export async function deriveRewardIdentityId(
  provider: RewardIdentityProvider,
  mechanism: string,
  nullifierHash: string,
): Promise<string> {
  const material = `${provider}:${mechanism}:${nullifierHash}`
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material))
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `rwi_${hex}`
}

export function resolveRewardIdentityProvider(raw: string | undefined): RewardIdentityProvider | null {
  const provider = String(raw ?? "").trim().toLowerCase()
  return SUPPORTED_REWARD_IDENTITY_PROVIDERS.find((candidate) => candidate === provider) ?? null
}

function isAttestationActive(input: {
  provider: RewardIdentityProvider
  verifiedAt: string | number | null
  expiresAt: string | number | null
  status: string | null
  nowMs: number
}): boolean {
  if (input.status !== "accepted") return false
  if (input.expiresAt != null) {
    const expiresAtMs = Date.parse(String(input.expiresAt))
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= input.nowMs) return false
  }
  const verifiedAtMs = typeof input.verifiedAt === "number"
    ? input.verifiedAt * 1000
    : Date.parse(String(input.verifiedAt ?? ""))
  if (!Number.isFinite(verifiedAtMs)) return false
  const capabilities = buildDefaultVerificationCapabilities()
  capabilities.unique_human = {
    state: "verified",
    provider: input.provider,
    proof_type: "unique_human",
    mechanism: "attestation",
    verified_at: Math.floor(verifiedAtMs / 1000),
  }
  return applyLazyCapabilityExpiry(capabilities, input.nowMs).unique_human.state === "verified"
}

/**
 * Cashout accepts any supported, live unique-human identity. The fixed provider
 * order makes selection reproducible if a user has more than one active identity.
 * New rows are governed by their source attestation; projection-only fallback is
 * retained for legacy/seeder nullifiers without one.
 */
export async function resolveActiveSupportedRewardIdentity(
  client: { execute(statement: InStatement | string): Promise<QueryResult> },
  userId: string,
  nowMs = Date.now(),
): Promise<ActiveRewardIdentity | null> {
  const [user, result] = await Promise.all([
    executeFirst(client, {
      sql: "SELECT verification_capabilities_json FROM users WHERE user_id = ?1 LIMIT 1",
      args: [userId],
    }),
    client.execute({
      sql: `
        SELECT n.provider, n.mechanism, n.nullifier_hash, n.source_user_attestation_id,
               a.status AS attestation_status, a.verified_at AS attestation_verified_at,
               a.expires_at AS attestation_expires_at
        FROM identity_nullifiers n
        LEFT JOIN user_attestations a
          ON a.user_attestation_id = n.source_user_attestation_id
         AND a.user_id = n.user_id
         AND a.provider = n.provider
         AND a.capability_key = 'unique_human'
        WHERE n.user_id = ?1
          AND n.status = 'active'
          AND n.provider IN (?2, ?3, ?4)
        ORDER BY CASE n.provider WHEN 'self' THEN 0 WHEN 'zkpassport' THEN 1 ELSE 2 END,
                 n.first_seen_at ASC, n.identity_nullifier_id ASC
      `,
      args: [userId, ...SUPPORTED_REWARD_IDENTITY_PROVIDERS],
    }),
  ])
  const projection = parseVerificationCapabilities(stringOrNull(rowValue(user, "verification_capabilities_json")))
  for (const row of result.rows) {
    const provider = resolveRewardIdentityProvider(stringOrNull(rowValue(row, "provider")) ?? undefined)
    const mechanism = stringOrNull(rowValue(row, "mechanism"))
    const nullifierHash = stringOrNull(rowValue(row, "nullifier_hash"))
    if (!provider || !mechanism || !nullifierHash) continue
    const sourceAttestationId = stringOrNull(rowValue(row, "source_user_attestation_id"))
    const active = sourceAttestationId
      ? isAttestationActive({
          provider,
          status: stringOrNull(rowValue(row, "attestation_status")),
          verifiedAt: rowValue(row, "attestation_verified_at") as string | number | null,
          expiresAt: rowValue(row, "attestation_expires_at") as string | number | null,
          nowMs,
        })
      : projection.unique_human.state === "verified" && projection.unique_human.provider === provider
    if (active) return { id: await deriveRewardIdentityId(provider, mechanism, nullifierHash), provider }
  }
  return null
}

export async function hasActiveUniqueHumanNullifier(
  client: { execute(statement: InStatement | string): Promise<QueryResult> },
  userId: string,
  requiredProvider: RewardIdentityProvider | null,
): Promise<boolean> {
  if (!requiredProvider) return false
  const user = await executeFirst(client, {
    sql: "SELECT verification_capabilities_json FROM users WHERE user_id = ?1 LIMIT 1",
    args: [userId],
  })
  const capabilities = parseVerificationCapabilities(stringOrNull(rowValue(user, "verification_capabilities_json")))
  if (capabilities.unique_human.state !== "verified" || capabilities.unique_human.provider !== requiredProvider) {
    return false
  }
  const row = await executeFirst(client, {
    sql: `
      SELECT identity_nullifier_id
      FROM identity_nullifiers
      WHERE user_id = ?1
        AND provider = ?2
        AND status = 'active'
      LIMIT 1
    `,
    args: [userId, requiredProvider],
  })
  return Boolean(row)
}

export async function resolveActiveRewardIdentity(
  client: { execute(statement: InStatement | string): Promise<QueryResult> },
  userId: string,
  requiredProvider: RewardIdentityProvider | null,
): Promise<ActiveRewardIdentity | null> {
  if (!requiredProvider) return null
  const user = await executeFirst(client, {
    sql: "SELECT verification_capabilities_json FROM users WHERE user_id = ?1 LIMIT 1",
    args: [userId],
  })
  const capabilities = parseVerificationCapabilities(stringOrNull(rowValue(user, "verification_capabilities_json")))
  if (capabilities.unique_human.state !== "verified" || capabilities.unique_human.provider !== requiredProvider) {
    return null
  }
  const row = await executeFirst(client, {
    sql: `
      SELECT mechanism, nullifier_hash
      FROM identity_nullifiers
      WHERE user_id = ?1 AND provider = ?2 AND status = 'active'
      ORDER BY first_seen_at ASC, identity_nullifier_id ASC
      LIMIT 1
    `,
    args: [userId, requiredProvider],
  })
  const mechanism = stringOrNull(rowValue(row, "mechanism"))
  const nullifierHash = stringOrNull(rowValue(row, "nullifier_hash"))
  if (!mechanism || !nullifierHash) return null
  return { id: await deriveRewardIdentityId(requiredProvider, mechanism, nullifierHash), provider: requiredProvider }
}
