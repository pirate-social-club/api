import type { DbExecutor } from "../db-helpers"
import { HttpError } from "../errors"
import {
  getCommunityDatabaseRoutingRow,
  type CommunityProvisioningState,
} from "./community-routing-repository"

/**
 * Router-side resolution of a community's database binding (Phase 0.1, step 2).
 *
 * `resolve` reads the control-plane `community_database_routing` directory,
 * caches the result, and returns the routing target the caller dispatches on.
 * The caller (router) invokes the shard service binding with `shardWorkerId` +
 * `bindingName`.
 *
 * Caching follows the design's dual-TTL rule: a 60s TTL for live routing entries
 * and a shorter 5s TTL for rows carrying `decommissioned_at`, so a decommission
 * is observed quickly. The cache is also invalidated explicitly on a binding
 * error (one-shot) via `invalidate`.
 */
export type ResolvedCommunityBinding = {
  communityId: string
  provisioningState: CommunityProvisioningState
  shardWorkerId: string | null
  bindingName: string | null
  region: string | null
  decommissionedAt: string | null
}

const ROUTING_CACHE_TTL_MS = 60_000
// Short TTL for non-stable routing states (degraded, decommissioned) so the
// router observes a recovery or a decommission quickly.
const SHORT_CACHE_TTL_MS = 5_000

type CacheEntry = {
  value: ResolvedCommunityBinding
  expiresAt: number
}

export type CommunityBindingResolverOptions = {
  now?: () => number
  routingTtlMs?: number
  shortTtlMs?: number
}

export class CommunityBindingResolver {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly now: () => number
  private readonly routingTtlMs: number
  private readonly shortTtlMs: number

  constructor(options: CommunityBindingResolverOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.routingTtlMs = options.routingTtlMs ?? ROUTING_CACHE_TTL_MS
    this.shortTtlMs = options.shortTtlMs ?? SHORT_CACHE_TTL_MS
  }

  private ttlFor(value: ResolvedCommunityBinding): number {
    if (
      value.provisioningState === "degraded" ||
      value.provisioningState === "decommissioned" ||
      value.decommissionedAt
    ) {
      return this.shortTtlMs
    }
    return this.routingTtlMs
  }

  async resolve(executor: DbExecutor, communityId: string): Promise<ResolvedCommunityBinding> {
    const value = await this.load(executor, communityId)

    // Fail closed: a decommissioned community has no live binding to route to.
    // The row is still cached (short TTL) so a flood of requests to a recently
    // decommissioned community does not hammer the control plane.
    if (value.provisioningState === "decommissioned" || value.decommissionedAt) {
      throw new HttpError(410, "community_decommissioned", "Community database binding has been decommissioned")
    }

    return value
  }

  private async load(executor: DbExecutor, communityId: string): Promise<ResolvedCommunityBinding> {
    const cached = this.cache.get(communityId)
    if (cached && this.now() < cached.expiresAt) {
      return cached.value
    }
    this.cache.delete(communityId)

    const row = await getCommunityDatabaseRoutingRow(executor, communityId)
    if (!row) {
      throw new HttpError(404, "community_not_found", "Community has no database routing entry")
    }

    if (row.provisioning_state === "provisioning") {
      // Deploy of the community's binding is still in flight. Do not cache: the
      // state flips to `ready` without a routing change the caller can observe.
      throw new HttpError(503, "binding_pending", "Community database binding is still provisioning", true)
    }

    const value: ResolvedCommunityBinding = {
      communityId: row.community_id,
      provisioningState: row.provisioning_state,
      shardWorkerId: row.shard_worker_id,
      bindingName: row.binding_name,
      region: row.region,
      decommissionedAt: row.decommissioned_at,
    }

    this.cache.set(communityId, { value, expiresAt: this.now() + this.ttlFor(value) })
    return value
  }

  /** Drop a cached entry — used on a binding error or after a known routing change. */
  invalidate(communityId: string): void {
    this.cache.delete(communityId)
  }

  /** Test/operational hook: clear the whole cache. */
  clear(): void {
    this.cache.clear()
  }
}
