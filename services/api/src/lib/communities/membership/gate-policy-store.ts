import type { ReadClient } from "../../sql-client"
import { validateGatePolicy } from "./gate-policy-validation"
import type { CommunityGateScope, GatePolicy } from "./gate-types"

export async function getGatePolicy(
  client: ReadClient,
  communityId: string,
  scope: CommunityGateScope,
): Promise<GatePolicy | null> {
  const result = await client.execute({
    sql: `
      SELECT expression_json
      FROM community_gate_policies
      WHERE community_id = ?1
        AND scope = ?2
      LIMIT 1
    `,
    args: [communityId, scope],
  })
  const raw = result.rows[0]?.expression_json
  if (raw == null) {
    return null
  }
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
  return validateGatePolicy(parsed)
}

export async function getMembershipGatePolicy(client: ReadClient, communityId: string): Promise<GatePolicy | null> {
  return getGatePolicy(client, communityId, "membership")
}
