import type { Env } from "../../env"
import { HttpError } from "../errors"

type ShardRegistryEnv = Pick<Env, "COMMUNITY_D1_SHARD" | "COMMUNITY_D1_SHARD_ROUTES">

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
