import type { ShardRpc } from "@pirate/api-shared"
import type { Env } from "../../env"
import { HttpError } from "../errors"

type ShardRegistryEnv = Pick<
  Env,
  "COMMUNITY_D1_ALLOCATION_SHARD_WORKER_ID" | "COMMUNITY_D1_SHARD" | "COMMUNITY_D1_SHARD_ROUTES"
>

export type ConfiguredCommunityShard = {
  shardWorkerId: string
  bindingName: string
  shard: ShardRpc
}

export type AllocationCommunityShard = Omit<ConfiguredCommunityShard, "shardWorkerId"> & {
  shardWorkerId: string | null
}

const routeCache = new WeakMap<object, { raw: string; routes: Record<string, string> }>()

function configuredRoutes(env: ShardRegistryEnv): Record<string, string> {
  const raw = String(env.COMMUNITY_D1_SHARD_ROUTES ?? "").trim()
  const cached = routeCache.get(env)
  if (cached?.raw === raw) return cached.routes
  if (!raw) return {}

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object")
    const routes: Record<string, string> = {}
    for (const [workerId, bindingName] of Object.entries(parsed)) {
      if (!workerId.trim() || typeof bindingName !== "string" || !bindingName.trim()) {
        throw new Error("worker ids and binding names must be non-empty strings")
      }
      routes[workerId] = bindingName
    }
    routeCache.set(env, { raw, routes })
    return routes
  } catch (error) {
    throw new HttpError(
      500,
      "d1_shard_registry_invalid",
      `COMMUNITY_D1_SHARD_ROUTES is invalid: ${error instanceof Error ? error.message : String(error)}`,
      false,
    )
  }
}

/** Resolve the service binding named by the routing row; never fall back across shard Workers. */
export function resolveCommunityShardRpc(env: ShardRegistryEnv, shardWorkerId: string | null) {
  if (!shardWorkerId) {
    throw new HttpError(500, "d1_shard_worker_missing", "D1 routing row has no shard_worker_id", false)
  }

  const bindingName = configuredRoutes(env)[shardWorkerId]
  if (!bindingName) {
    throw new HttpError(
      503,
      "d1_shard_worker_not_configured",
      `D1 shard Worker ${shardWorkerId} is not configured on this API Worker`,
      false,
    )
  }

  const shard = (env as unknown as Record<string, unknown>)[bindingName]
  if (!shard || typeof shard !== "object") {
    throw new HttpError(
      503,
      "d1_shard_binding_not_configured",
      `D1 service binding ${bindingName} for shard Worker ${shardWorkerId} is not configured`,
      false,
    )
  }
  return shard as NonNullable<Env["COMMUNITY_D1_SHARD"]>
}

/** Enumerate every configured shard Worker, validating every named binding. */
export function listConfiguredCommunityShards(env: ShardRegistryEnv): ConfiguredCommunityShard[] {
  return Object.entries(configuredRoutes(env))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([shardWorkerId, bindingName]) => ({
      shardWorkerId,
      bindingName,
      shard: resolveCommunityShardRpc(env, shardWorkerId),
    }))
}

/**
 * Resolve the sole pool allowed to allocate new communities.
 *
 * A single configured route is unambiguous and remains backwards-compatible.
 * Once multiple pools exist, an explicit selector is mandatory. This is
 * intentionally not a capacity-based fallback: changing capacity between two
 * retries must never move an in-flight community to another pool.
 */
export function resolveCommunityAllocationShard(env: ShardRegistryEnv): AllocationCommunityShard {
  const shards = listConfiguredCommunityShards(env)
  const selectedWorkerId = String(env.COMMUNITY_D1_ALLOCATION_SHARD_WORKER_ID ?? "").trim()
  if (selectedWorkerId) {
    const selected = shards.find((entry) => entry.shardWorkerId === selectedWorkerId)
    if (!selected) {
      throw new HttpError(
        503,
        "d1_allocation_shard_not_configured",
        `Allocation shard Worker ${selectedWorkerId} is not configured in COMMUNITY_D1_SHARD_ROUTES`,
        false,
      )
    }
    return selected
  }
  if (shards.length === 1) return shards[0]!
  if (shards.length > 1) {
    throw new HttpError(
      503,
      "d1_allocation_shard_ambiguous",
      "COMMUNITY_D1_ALLOCATION_SHARD_WORKER_ID is required when multiple D1 shard routes are configured",
      false,
    )
  }
  if (env.COMMUNITY_D1_SHARD) {
    return {
      shardWorkerId: null,
      bindingName: "COMMUNITY_D1_SHARD",
      shard: env.COMMUNITY_D1_SHARD,
    }
  }
  throw new HttpError(
    503,
    "d1_allocation_shard_not_configured",
    "No D1 shard route is configured for allocation",
    false,
  )
}
