import type { Address } from "viem"

import type { Client, QueryResultRow } from "../sql-client"
import type { UserRepository } from "../auth/repositories"

export type FollowReadAvailability =
  | "current"
  | "projection_initializing"
  | "projection_stale"
  | "projection_rebuilding"
  | "projection_unavailable"

export type ProfileFollowReadModel = {
  object: "profile_follow_state"
  target_user_id: string
  target_wallet: { status: "available"; address: Address } | { status: "no_wallet" }
  relationship: {
    status: "current" | "viewer_anonymous" | "viewer_no_wallet" | "unavailable"
    viewer_follows: boolean | null
  }
  counts: {
    status: "current" | "unavailable" | "not_applicable"
    follower_count: number | null
    following_count: number | null
  }
  projection: {
    availability: FollowReadAvailability
    revision: string
    indexed_through_block: Array<{ chain_id: number; block_number: string }>
  }
}

function integer(row: QueryResultRow | undefined, key: string): bigint | null {
  const value = row?.[key]
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === "string" && /^\d+$/u.test(value)) return BigInt(value)
  return null
}

export async function canonicalFollowWallet(
  users: UserRepository,
  userId: string,
): Promise<Address | null> {
  const wallets = await users.getWalletAttachmentsByUserId(userId)
  const primary = wallets.find((wallet) =>
    wallet.is_primary && /^eip155(?::\d+)?$/u.test(wallet.chain_namespace)
  )
  const address = primary?.wallet_address.trim().toLowerCase()
  return address && /^0x[0-9a-f]{40}$/u.test(address) ? address as Address : null
}

function availability(status: unknown): FollowReadAvailability {
  switch (status) {
    case "current":
      return "current"
    case "initializing":
      return "projection_initializing"
    case "stale":
      return "projection_stale"
    case "rebuilding":
      return "projection_rebuilding"
    default:
      return "projection_unavailable"
  }
}

export async function readProfileFollowState(input: {
  client: Client
  users: UserRepository
  targetUserId: string
  targetPublicUserId: string
  viewerUserId: string | null
}): Promise<ProfileFollowReadModel> {
  const [targetWallet, viewerWallet, stateResult, watermarkResult] = await Promise.all([
    canonicalFollowWallet(input.users, input.targetUserId),
    input.viewerUserId ? canonicalFollowWallet(input.users, input.viewerUserId) : Promise.resolve(null),
    input.client.execute(`
      SELECT status, projection_revision
      FROM efp_follow_projection_state
      WHERE projection_key = 'effective-graph'
    `),
    input.client.execute(`
      SELECT chain_id, applied_through_block
      FROM efp_follow_projection_chain_watermarks
      ORDER BY chain_id ASC
    `),
  ])

  const state = stateResult.rows[0]
  const projectionAvailability = availability(state?.status)
  const projectionRevision = integer(state, "projection_revision")?.toString() ?? "0"
  const watermarks = watermarkResult.rows.flatMap((row) => {
    const chainId = integer(row, "chain_id")
    const block = integer(row, "applied_through_block")
    return chainId != null && block != null
      ? [{ chain_id: Number(chainId), block_number: block.toString() }]
      : []
  })
  const projection = {
    availability: projectionAvailability,
    revision: projectionRevision,
    indexed_through_block: watermarks,
  }

  if (!targetWallet) {
    return {
      object: "profile_follow_state",
      target_user_id: input.targetPublicUserId,
      target_wallet: { status: "no_wallet" },
      relationship: {
        status: input.viewerUserId ? "unavailable" : "viewer_anonymous",
        viewer_follows: null,
      },
      counts: { status: "not_applicable", follower_count: null, following_count: null },
      projection,
    }
  }

  if (projectionAvailability !== "current") {
    return {
      object: "profile_follow_state",
      target_user_id: input.targetPublicUserId,
      target_wallet: { status: "available", address: targetWallet },
      relationship: { status: "unavailable", viewer_follows: null },
      counts: { status: "unavailable", follower_count: null, following_count: null },
      projection,
    }
  }

  const [countResult, edgeResult] = await Promise.all([
    input.client.execute({
      sql: `
        SELECT follower_count, following_count
        FROM efp_follow_counts
        WHERE wallet_address = ?1
      `,
      args: [targetWallet],
    }),
    viewerWallet
      ? input.client.execute({
          sql: `
            SELECT 1 AS follows
            FROM efp_effective_follows
            WHERE follower_address = ?1 AND followed_address = ?2
            LIMIT 1
          `,
          args: [viewerWallet, targetWallet],
        })
      : Promise.resolve({ rows: [] }),
  ])
  const followerCount = integer(countResult.rows[0], "follower_count") ?? 0n
  const followingCount = integer(countResult.rows[0], "following_count") ?? 0n

  return {
    object: "profile_follow_state",
    target_user_id: input.targetPublicUserId,
    target_wallet: { status: "available", address: targetWallet },
    relationship: input.viewerUserId
      ? viewerWallet
        ? { status: "current", viewer_follows: edgeResult.rows.length > 0 }
        : { status: "viewer_no_wallet", viewer_follows: null }
      : { status: "viewer_anonymous", viewer_follows: null },
    counts: {
      status: "current",
      follower_count: Number(followerCount),
      following_count: Number(followingCount),
    },
    projection,
  }
}

function nonNegativeCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value)
  return null
}

export async function shadowCompareProfileFollowState(input: {
  owned: ProfileFollowReadModel
  viewerWallet: Address | null
  apiUrl?: string
  fetcher?: typeof fetch
}): Promise<void> {
  if (input.owned.target_wallet.status !== "available" || input.owned.projection.availability !== "current") return
  const fetcher = input.fetcher ?? fetch
  const apiUrl = (input.apiUrl ?? "https://api.ethfollow.xyz").replace(/\/+$/u, "")
  const target = input.owned.target_wallet.address
  try {
    const requests: Promise<Response>[] = [
      fetcher(`${apiUrl}/api/v1/users/${target}/stats?live=true`, { headers: { Accept: "application/json" } }),
    ]
    if (input.viewerWallet) {
      requests.push(fetcher(`${apiUrl}/api/v1/users/${input.viewerWallet}/${target}/relationship`, {
        headers: { Accept: "application/json" },
      }))
    }
    const [statsResponse, relationshipResponse] = await Promise.all(requests)
    if (!statsResponse?.ok || (relationshipResponse && !relationshipResponse.ok)) {
      throw new Error(`hosted_status:${statsResponse?.status ?? "missing"}:${relationshipResponse?.status ?? "none"}`)
    }
    const stats = await statsResponse.json() as Record<string, unknown>
    const relationship = relationshipResponse
      ? await relationshipResponse.json() as { state?: { is_following?: unknown } }
      : null
    const hostedFollowerCount = nonNegativeCount(stats.followers_count)
    const hostedFollowingCount = nonNegativeCount(stats.following_count)
    const hostedRelationship = relationship?.state?.is_following
    console.info("[efp-follow-shadow]", JSON.stringify({
      target,
      projection_revision: input.owned.projection.revision,
      indexed_through_block: input.owned.projection.indexed_through_block,
      owned_follower_count: input.owned.counts.follower_count,
      hosted_follower_count: hostedFollowerCount,
      owned_following_count: input.owned.counts.following_count,
      hosted_following_count: hostedFollowingCount,
      owned_viewer_follows: input.owned.relationship.viewer_follows,
      hosted_viewer_follows: typeof hostedRelationship === "boolean" ? hostedRelationship : null,
      counts_match: hostedFollowerCount === input.owned.counts.follower_count
        && hostedFollowingCount === input.owned.counts.following_count,
      relationship_matches: input.viewerWallet == null
        || (typeof hostedRelationship === "boolean"
          && hostedRelationship === input.owned.relationship.viewer_follows),
    }))
  } catch (error) {
    console.warn("[efp-follow-shadow] hosted comparison unavailable", {
      target,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
