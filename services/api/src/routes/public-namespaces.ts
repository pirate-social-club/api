import { Hono } from "hono"
import {
  evaluateJoinedRoot,
  ROOT_DELEGATION_JOIN_SQL,
  ROOT_DELEGATION_SELECT_SQL,
  type RootDelegationJoinRow,
} from "@pirate/hns-delegation"
import { decodePublicNamespaceVerificationId, publicCommunityId, publicId } from "../lib/public-ids"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { notFoundError } from "../lib/errors"
import { normalizeRootLabel } from "../lib/verification/labels"
import type { Env } from "../env"

const publicNamespaces = new Hono<{ Bindings: Env }>()

type PublicNamespaceRow = Record<string, unknown>

function rootDelegationRoutingEnabled(env: Env): boolean {
  return env.HNS_ROOT_DELEGATION_ROUTING_ENABLED?.trim().toLowerCase() === "true"
}

function rootDelegationAllowsRouting(row: PublicNamespaceRow, nowMs: number): boolean {
  if (typeof row.delegation_root_label !== "string") {
    const evaluation = evaluateJoinedRoot(null, nowMs)
    return evaluation.authenticatedRoutingAllowed && evaluation.canonicalRoutingEligible
  }
  const evaluation = evaluateJoinedRoot(
    row as unknown as RootDelegationJoinRow,
    nowMs,
  )
  return evaluation.authenticatedRoutingAllowed && evaluation.canonicalRoutingEligible
}

function normalizePublicHnsRoot(value: string): string | null {
  const normalized = normalizeRootLabel(value)
  if (!normalized || normalized.includes(".")) {
    return null
  }
  return normalized
}

function serializePublicNamespaceRow(row: PublicNamespaceRow, fallbackRootLabel: string) {
  const rootLabel = typeof row.normalized_root_label === "string"
    ? row.normalized_root_label
    : fallbackRootLabel
  const communityId = typeof row.community_id === "string" ? row.community_id : null
  if (!communityId) {
    return null
  }

  return {
    root_label: rootLabel,
    wallet_interactive:
      row.wallet_registration_status === "registered"
      && Number(row.wallet_canonical_routing_eligible) === 1
      && Number(row.wallet_routing_hard_denied) === 0,
    namespace_role: row.namespace_role === "mirror" ? "mirror" : "primary",
    namespace_verification: typeof row.namespace_verification_id === "string"
      ? row.namespace_verification_id.startsWith("nv_")
        ? row.namespace_verification_id
        : publicId(decodePublicNamespaceVerificationId(row.namespace_verification_id), "nv")
      : null,
    community: {
      id: publicCommunityId(communityId),
      display_name: typeof row.display_name === "string" ? row.display_name : null,
      route_slug: row.namespace_role !== "mirror" && typeof row.route_slug === "string" && row.route_slug.trim()
        ? row.route_slug
        : rootLabel,
    },
  }
}

function publicNamespaceSelectSql(
  whereClause: string,
  useRootDelegationState: boolean,
): string {
  return `
    SELECT
      nv.normalized_root_label,
      nv.namespace_verification_id,
      COALESCE(cnb.namespace_role, 'primary') AS namespace_role,
      c.community_id,
      c.display_name,
      c.route_slug,
      wallet.registration_status AS wallet_registration_status,
      wallet_state.canonical_routing_eligible AS wallet_canonical_routing_eligible,
      wallet_state.routing_hard_denied AS wallet_routing_hard_denied
      ${useRootDelegationState ? `, ${ROOT_DELEGATION_SELECT_SQL}` : ""}
    FROM namespace_verifications AS nv
    JOIN communities AS c
      ON c.namespace_verification_id = nv.namespace_verification_id
      OR EXISTS (
        SELECT 1
        FROM community_namespace_bindings attached
        WHERE attached.community_id = c.community_id
          AND attached.namespace_verification_id = nv.namespace_verification_id
          AND attached.status = 'active'
      )
    LEFT JOIN community_namespace_bindings AS cnb
      ON cnb.community_id = c.community_id
     AND cnb.namespace_verification_id = nv.namespace_verification_id
     AND cnb.status = 'active'
    LEFT JOIN hns_wallet_origin_authority AS wallet
      ON wallet.normalized_root_label = nv.normalized_root_label
    LEFT JOIN hns_root_delegation_state AS wallet_state
      ON wallet_state.normalized_root_label = nv.normalized_root_label
    ${useRootDelegationState ? ROOT_DELEGATION_JOIN_SQL : ""}
    WHERE nv.family = 'hns'
      AND nv.status = 'verified'
      ${useRootDelegationState
        ? ""
        : "AND nv.pirate_dns_authority_verified = 1 AND nv.pirate_web_routing_allowed = 1"}
      AND nv.expires_at > ?1
      AND c.status = 'active'
      AND c.provisioning_state = 'active'
      ${whereClause}
  `
}

publicNamespaces.get("/", async (c) => {
  const client = getControlPlaneClient(c.env)
  const now = new Date().toISOString()
  const nowMs = Date.parse(now)
  const useRootDelegationState = rootDelegationRoutingEnabled(c.env)
  const result = await client.execute({
    sql: `${publicNamespaceSelectSql("", useRootDelegationState)}
      ORDER BY nv.normalized_root_label ASC
      LIMIT 500
    `,
    args: [now],
  })

  return c.json({
    namespaces: result.rows
      .filter((row) =>
        !useRootDelegationState || rootDelegationAllowsRouting(row, nowMs)
      )
      .map((row) => serializePublicNamespaceRow(row, ""))
      .filter((row) => row !== null),
  }, 200, {
    "cache-control": "public, max-age=60",
  })
})

publicNamespaces.get("/:rootLabel", async (c) => {
  const rootLabel = normalizePublicHnsRoot(c.req.param("rootLabel"))
  if (!rootLabel) {
    throw notFoundError("Namespace not found")
  }

  const client = getControlPlaneClient(c.env)
  const now = new Date().toISOString()
  const nowMs = Date.parse(now)
  const useRootDelegationState = rootDelegationRoutingEnabled(c.env)
  const result = await client.execute({
    sql: `${publicNamespaceSelectSql(
      "AND nv.normalized_root_label = ?2",
      useRootDelegationState,
    )}
      LIMIT 1
    `,
    args: [now, rootLabel],
  })

  const row = result.rows[0]
  if (row && useRootDelegationState && !rootDelegationAllowsRouting(row, nowMs)) {
    throw notFoundError("Namespace not found")
  }
  const body = row ? serializePublicNamespaceRow(row, rootLabel) : null
  if (!body) {
    throw notFoundError("Namespace not found")
  }

  return c.json(body, 200, {
    // The gateway consumes this endpoint as the wallet-interactivity authority.
    // Do not let a CDN or browser retain an enabled answer after hard denial.
    "cache-control": "no-store",
  })
})

export default publicNamespaces
