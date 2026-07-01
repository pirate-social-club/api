import type { DbExecutor } from "../db-helpers"
import type { ReadClient } from "../sql-client"
import { HttpError } from "../errors"
import type { CommunityBindingResolver, ResolvedCommunityBinding } from "./community-binding-resolver"

/**
 * Error codes that mean the cached routing entry points at a binding the backend
 * can no longer serve (stale directory row, dropped binding). Only these justify
 * dropping the cache entry. Transient failures (an unreachable shard, a timeout)
 * must NOT invalidate — re-resolving would add control-plane load without fixing
 * anything, and the entry is still correct.
 */
const STALE_BINDING_ERROR_CODES = new Set(["binding_stale", "binding_not_found"])

function isStaleBindingError(error: unknown): boolean {
  return error instanceof HttpError && STALE_BINDING_ERROR_CODES.has(error.code)
}

/**
 * Router read path. Composes the binding resolver with backend
 * dispatch — the documented hot path for a community-touching read:
 *
 *   1. resolve the binding from the control-plane directory (cached)
 *   2. open the shard read client through the service binding
 *   3. on a binding error, invalidate the cache one-shot and rethrow
 *
 * The shard invoker is injected for tests. This boundary owns cache
 * invalidation only — it does not own the binding's lifecycle (the shard does).
 */
export type CommunityReadInvoker = (binding: ResolvedCommunityBinding) => Promise<ReadClient>

export type CommunityReadRouterDeps = {
  resolver: CommunityBindingResolver
  controlPlane: DbExecutor
  openShardReadClient: CommunityReadInvoker
}

export type RoutedCommunityRead = {
  binding: ResolvedCommunityBinding
  client: ReadClient
}

export async function routeCommunityRead(
  deps: CommunityReadRouterDeps,
  communityId: string,
): Promise<RoutedCommunityRead> {
  const binding = await deps.resolver.resolve(deps.controlPlane, communityId)
  try {
    const client = await deps.openShardReadClient(binding)
    return { binding, client }
  } catch (error) {
    // Only drop the cache when the directory pointed at a binding the backend
    // can no longer serve. Transient failures keep the (still-correct) entry.
    if (isStaleBindingError(error)) {
      deps.resolver.invalidate(communityId)
    }
    throw error
  }
}
