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
    return evaluateJoinedRoot(null, nowMs).authenticatedRoutingAllowed
  }
  return evaluateJoinedRoot(
    row as unknown as RootDelegationJoinRow,
    nowMs,
  ).authenticatedRoutingAllowed
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
      c.route_slug
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
    ${useRootDelegationState ? ROOT_DELEGATION_JOIN_SQL : ""}
    WHERE nv.family = 'hns'
      AND nv.status = 'verified'
      AND nv.pirate_dns_authority_verified = 1
      ${useRootDelegationState ? "" : "AND nv.pirate_web_routing_allowed = 1"}
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
    "cache-control": "public, max-age=60",
  })
})

export default publicNamespaces
