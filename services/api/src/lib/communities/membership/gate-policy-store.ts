import type { Client } from "../../sql-client"
import type { Env } from "../../../env"
import { validateGatePolicy } from "./gate-policy-validation"
import type { CommunityGateScope, GatePolicy } from "./gate-types"

const DEFAULT_GATE_POLICY_CACHE_TTL_MS = 60_000

type CachedMembershipGatePolicy = {
  expiresAt: number
  policy: GatePolicy | null
}

const membershipGatePolicyCache = new Map<string, CachedMembershipGatePolicy>()

function parseCacheTtlMs(env: Env): number {
  const parsed = Number(env.COMMUNITY_GATE_POLICY_CACHE_TTL_MS)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_GATE_POLICY_CACHE_TTL_MS
}

export async function getGatePolicy(
  client: Client,
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

export async function getMembershipGatePolicy(client: Client, communityId: string): Promise<GatePolicy | null> {
  return getGatePolicy(client, communityId, "membership")
}

export async function getCachedMembershipGatePolicy(input: {
  env: Env
  client: Client
  communityId: string
}): Promise<GatePolicy | null> {
  const ttlMs = parseCacheTtlMs(input.env)
  if (ttlMs === 0) {
    return getMembershipGatePolicy(input.client, input.communityId)
  }

  const now = Date.now()
  const cached = membershipGatePolicyCache.get(input.communityId)
  if (cached && cached.expiresAt > now) {
    return cached.policy
  }

  const policy = await getMembershipGatePolicy(input.client, input.communityId)
  membershipGatePolicyCache.set(input.communityId, {
    expiresAt: now + ttlMs,
    policy,
  })
  return policy
}

export function invalidateMembershipGatePolicyCache(communityId?: string): void {
  if (communityId) {
    membershipGatePolicyCache.delete(communityId)
    return
  }
  membershipGatePolicyCache.clear()
}
