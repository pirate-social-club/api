import { executeFirst } from "../db-helpers"
import type { InStatement, QueryResult } from "../sql-client"
import { rowValue, stringOrNull } from "../sql-row"
import { parseVerificationCapabilities } from "../auth/auth-serializers"

export type RewardIdentityProvider = "self" | "very"

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
