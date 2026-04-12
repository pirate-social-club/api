import { badRequestError, notFoundError } from "../errors"
import { createControlPlaneDbClient } from "../control-plane-db"
import { getUserRepository } from "../auth/repositories"
import { getCommunity } from "./community-service"
import { getControlPlaneCommunityRepository } from "./control-plane-community-repository"
import type { Env } from "../../types"

function normalizeNamespaceLabel(value: string): {
  normalizedLabel: string
  prefixed: boolean
} {
  const trimmed = value.trim()
  const normalizedLabel = trimmed.replace(/^@+/, "").toLowerCase()
  return {
    normalizedLabel,
    prefixed: /^\s*@+/u.test(value),
  }
}

async function resolveCommunityIdByNamespace(env: Env, rawNamespaceLabel: string): Promise<string | null> {
  const { normalizedLabel, prefixed } = normalizeNamespaceLabel(rawNamespaceLabel)
  if (!normalizedLabel) {
    throw badRequestError("Namespace label is required")
  }

  const client = createControlPlaneDbClient(env)

  try {
    const spacesResult = await client.execute({
      sql: `
        SELECT c.community_id
        FROM communities AS c
        INNER JOIN namespace_verifications AS nv
          ON nv.namespace_verification_id = c.namespace_verification_id
        WHERE nv.normalized_root_label = ?1
          AND nv.family = 'spaces'
          AND c.status = 'active'
          AND c.provisioning_state = 'active'
        ORDER BY c.created_at DESC, c.community_id DESC
        LIMIT 1
      `,
      args: [normalizedLabel],
    })

    const spacesCommunityId = spacesResult.rows[0]?.community_id
    if (typeof spacesCommunityId === "string" && spacesCommunityId.length > 0) {
      return spacesCommunityId
    }

    if (prefixed) {
      return null
    }

    const routeResult = await client.execute({
      sql: `
        SELECT c.community_id
        FROM communities AS c
        LEFT JOIN namespace_verifications AS nv
          ON nv.namespace_verification_id = c.namespace_verification_id
        WHERE c.status = 'active'
          AND c.provisioning_state = 'active'
          AND (
            c.route_slug = ?1
            OR nv.normalized_root_label = ?1
          )
        ORDER BY
          CASE
            WHEN c.route_slug = ?1 THEN 0
            WHEN nv.normalized_root_label = ?1 THEN 1
            ELSE 2
          END,
          c.created_at DESC,
          c.community_id DESC
        LIMIT 1
      `,
      args: [normalizedLabel],
    })

    const routeCommunityId = routeResult.rows[0]?.community_id
    return typeof routeCommunityId === "string" && routeCommunityId.length > 0
      ? routeCommunityId
      : null
  } finally {
    await client.close()
  }
}

export async function getCommunityByNamespaceRoute(input: {
  env: Env
  namespaceLabel: string
}) {
  const communityId = await resolveCommunityIdByNamespace(input.env, input.namespaceLabel)
  if (!communityId) {
    throw notFoundError("Community not found")
  }

  return getCommunity({
    communityId,
    repository: getControlPlaneCommunityRepository(input.env),
    userRepository: getUserRepository(input.env),
  })
}
