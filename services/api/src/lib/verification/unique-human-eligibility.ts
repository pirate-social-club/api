import { executeFirst } from "../db-helpers"
import type { InStatement, QueryResult } from "../sql-client"
import { rowValue, stringOrNull } from "../sql-row"
import { parseVerificationCapabilities } from "../auth/auth-serializers"
import { readActiveIdentityEvidence } from "./provider-keyed-identity-evidence"

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
  const [user, result, evidence] = await Promise.all([
    executeFirst(client, {
      sql: "SELECT verification_capabilities_json FROM users WHERE user_id = ?1 LIMIT 1",
      args: [userId],
    }),
    client.execute({
      sql: `
        SELECT n.identity_nullifier_id, n.provider, n.mechanism, n.nullifier_hash, n.source_user_attestation_id,
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
    readActiveIdentityEvidence({ client, userId, now: new Date(nowMs), capabilities: ["unique_human"] }),
  ])
  const projection = parseVerificationCapabilities(stringOrNull(rowValue(user, "verification_capabilities_json")))
  const durableEvidenceIds = new Set(
    evidence
      .filter((item) => item.capability === "unique_human")
      .map((item) => item.sourceIdentityNullifierId)
      .filter((value): value is string => value !== null),
  )
  for (const row of result.rows) {
    const identityNullifierId = stringOrNull(rowValue(row, "identity_nullifier_id"))
    const provider = resolveRewardIdentityProvider(stringOrNull(rowValue(row, "provider")) ?? undefined)
    const mechanism = stringOrNull(rowValue(row, "mechanism"))
    const nullifierHash = stringOrNull(rowValue(row, "nullifier_hash"))
    if (!provider || !mechanism || !nullifierHash) continue
    const sourceAttestationId = stringOrNull(rowValue(row, "source_user_attestation_id"))
    const active = sourceAttestationId
      ? identityNullifierId !== null && durableEvidenceIds.has(identityNullifierId)
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
  const evidence = await readActiveIdentityEvidence({ client, userId, capabilities: ["unique_human"] })
  return evidence.some((item) => item.capability === "unique_human" && item.provider === requiredProvider)
}

export async function resolveActiveRewardIdentity(
  client: { execute(statement: InStatement | string): Promise<QueryResult> },
  userId: string,
  requiredProvider: RewardIdentityProvider | null,
): Promise<ActiveRewardIdentity | null> {
  if (!requiredProvider) return null
  const evidence = await readActiveIdentityEvidence({ client, userId, capabilities: ["unique_human"] })
  const durableEvidenceIds = new Set(
    evidence
      .filter((item) => item.provider === requiredProvider)
      .map((item) => item.sourceIdentityNullifierId)
      .filter((value): value is string => value !== null),
  )
  const row = await executeFirst(client, {
    sql: `
      SELECT identity_nullifier_id, mechanism, nullifier_hash
      FROM identity_nullifiers
      WHERE user_id = ?1 AND provider = ?2 AND status = 'active'
      ORDER BY first_seen_at ASC, identity_nullifier_id ASC
      LIMIT 1
    `,
    args: [userId, requiredProvider],
  })
  const mechanism = stringOrNull(rowValue(row, "mechanism"))
  const nullifierHash = stringOrNull(rowValue(row, "nullifier_hash"))
  const identityNullifierId = stringOrNull(rowValue(row, "identity_nullifier_id"))
  if (!mechanism || !nullifierHash || !identityNullifierId || !durableEvidenceIds.has(identityNullifierId)) return null
  return { id: await deriveRewardIdentityId(requiredProvider, mechanism, nullifierHash), provider: requiredProvider }
}
