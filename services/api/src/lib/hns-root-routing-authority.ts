import {
  evaluateJoinedRoot,
  ROOT_DELEGATION_JOIN_SQL,
  ROOT_DELEGATION_SELECT_SQL,
  type RootDelegationJoinRow,
} from "@pirate/hns-delegation"

import type { Client } from "./sql-client"
import { normalizeRootLabel } from "./verification/labels"

/**
 * CORS is intentionally allowed to lag an activation/revocation write by at
 * most this long. The request-time Durable Object projection is refreshed when
 * this TTL expires; it is not an unbounded cache and it is never the source of
 * truth for routing.
 */
export const HNS_ROOT_ROUTING_AUTHORITY_TTL_MS = 60_000

export type HnsRootRoutingAuthorityRead = {
  effective: boolean
  reasonCode: "enabled" | "not_activated" | "hard_denied" | "expired" | "not_found"
}

function rootLabel(value: string): string | null {
  const normalized = normalizeRootLabel(value)
  return normalized && !normalized.includes(".") ? normalized : null
}

function reasonCode(input: {
  effective: boolean
  row: RootDelegationJoinRow | null
  nowMs: number
}): HnsRootRoutingAuthorityRead["reasonCode"] {
  if (input.effective) return "enabled"
  if (!input.row) return "not_found"
  if (input.row.delegation_routing_hard_denied === 1 || input.row.delegation_routing_hard_denied === true) {
    return "hard_denied"
  }
  if (input.row.delegation_observed_at) {
    const observedAt = input.row.delegation_observed_at instanceof Date
      ? input.row.delegation_observed_at.getTime()
      : Date.parse(String(input.row.delegation_observed_at))
    if (Number.isFinite(observedAt) && input.nowMs - observedAt > 900_000) return "expired"
  }
  return "not_activated"
}

/**
 * Read activation using the same joined/evaluated delegation model as the
 * public namespace route. A missing row, stale observation, hard deny, expired
 * namespace, or inactive community all fail closed.
 */
export async function readHnsRootRoutingAuthority(
  client: Pick<Client, "execute">,
  rawRootLabel: string,
  now = new Date(),
): Promise<HnsRootRoutingAuthorityRead> {
  const normalized = rootLabel(rawRootLabel)
  if (!normalized) return { effective: false, reasonCode: "not_found" }
  const nowMs = now.getTime()
  const nowIso = now.toISOString()
  const result = await client.execute({
    sql: `
      SELECT ${ROOT_DELEGATION_SELECT_SQL}
      FROM namespace_verifications AS nv
      JOIN communities AS community
        ON (
          community.namespace_verification_id = nv.namespace_verification_id
          OR EXISTS (
            SELECT 1
            FROM community_namespace_bindings AS binding
            WHERE binding.community_id = community.community_id
              AND binding.namespace_verification_id = nv.namespace_verification_id
              AND binding.status = 'active'
          )
        )
       AND community.status = 'active'
       AND community.provisioning_state = 'active'
      ${ROOT_DELEGATION_JOIN_SQL}
      WHERE nv.family = 'hns'
        AND nv.normalized_root_label = ?1
        AND nv.status = 'verified'
        AND nv.expires_at > ?2
      LIMIT 1
    `,
    args: [normalized, nowIso],
  })

  const row = (result.rows[0] ?? null) as unknown as RootDelegationJoinRow | null
  const joinedRow = typeof row?.delegation_root_label === "string" ? row : null
  const evaluation = joinedRow
    ? evaluateJoinedRoot(joinedRow, nowMs)
    : evaluateJoinedRoot(null, nowMs)
  const effective = evaluation.authenticatedRoutingAllowed
    && evaluation.canonicalRoutingEligible
    && !evaluation.routingHardDenied
  return {
    effective,
    reasonCode: reasonCode({ effective, row: joinedRow, nowMs }),
  }
}
