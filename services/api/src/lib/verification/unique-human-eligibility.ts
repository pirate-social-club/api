import { executeFirst } from "../db-helpers"
import type { InStatement, QueryResult } from "../sql-client"
import { rowValue, stringOrNull } from "../sql-row"
import { parseVerificationCapabilities } from "../auth/auth-serializers"

export type RewardIdentityProvider = "self" | "very"

export type ActiveRewardIdentity = {
  id: string
  provider: RewardIdentityProvider
}

export function resolveRewardIdentityProvider(raw: string | undefined): RewardIdentityProvider | null {
  const provider = String(raw ?? "").trim().toLowerCase()
  return provider === "self" || provider === "very" ? provider : null
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
  const material = `${requiredProvider}:${mechanism}:${nullifierHash}`
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material))
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return { id: `rwi_${hex}`, provider: requiredProvider }
}
