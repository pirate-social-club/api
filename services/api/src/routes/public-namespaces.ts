import { Hono } from "hono"
import { decodePublicNamespaceVerificationId, publicCommunityId, publicId } from "../lib/public-ids"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { notFoundError } from "../lib/errors"
import { normalizeRootLabel } from "../lib/verification/labels"
import type { Env } from "../env"

const publicNamespaces = new Hono<{ Bindings: Env }>()

type PublicNamespaceRow = {
  normalized_root_label: unknown
  namespace_verification_id: unknown
  community_id: unknown
  display_name: unknown
  route_slug: unknown
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
    namespace_verification: typeof row.namespace_verification_id === "string"
      ? row.namespace_verification_id.startsWith("nv_")
        ? row.namespace_verification_id
        : publicId(decodePublicNamespaceVerificationId(row.namespace_verification_id), "nv")
      : null,
    community: {
      id: publicCommunityId(communityId),
      display_name: typeof row.display_name === "string" ? row.display_name : null,
      route_slug: typeof row.route_slug === "string" && row.route_slug.trim()
        ? row.route_slug
        : rootLabel,
    },
  }
}

function publicNamespaceSelectSql(whereClause: string): string {
  return `
    SELECT
      nv.normalized_root_label,
      nv.namespace_verification_id,
      c.community_id,
      c.display_name,
      c.route_slug
    FROM namespace_verifications AS nv
    JOIN communities AS c
      ON c.namespace_verification_id = nv.namespace_verification_id
    WHERE nv.family = 'hns'
      AND nv.status = 'verified'
      AND nv.pirate_dns_authority_verified = 1
      AND nv.pirate_web_routing_allowed = 1
      AND nv.expires_at > ?1
      AND c.status = 'active'
      AND c.provisioning_state = 'active'
      ${whereClause}
  `
}

publicNamespaces.get("/", async (c) => {
  const client = getControlPlaneClient(c.env)
  const now = new Date().toISOString()
  const result = await client.execute({
    sql: `${publicNamespaceSelectSql("")}
      ORDER BY nv.normalized_root_label ASC
      LIMIT 500
    `,
    args: [now],
  })

  return c.json({
    namespaces: result.rows
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
  const result = await client.execute({
    sql: `${publicNamespaceSelectSql("AND nv.normalized_root_label = ?2")}
      LIMIT 1
    `,
    args: [now, rootLabel],
  })

  const row = result.rows[0]
  const body = row ? serializePublicNamespaceRow(row, rootLabel) : null
  if (!body) {
    throw notFoundError("Namespace not found")
  }

  return c.json(body, 200, {
    "cache-control": "public, max-age=60",
  })
})

export default publicNamespaces
