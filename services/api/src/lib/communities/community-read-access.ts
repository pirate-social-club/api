import type { Env } from "../../env"
import type { DbExecutor } from "../db-helpers"
import { globalSingleton } from "../db-helpers"
import { HttpError } from "../errors"
import { getControlPlaneClient } from "../runtime-deps"
import type { ReadClient } from "../sql-client"
import { CommunityBindingResolver } from "./community-binding-resolver"
import { openCommunityDb } from "./community-db-factory"
import {
  routeCommunityRead,
  type CommunityReadInvoker,
} from "./community-read-router"
import type { CommunityDatabaseBindingRepository } from "./community-repository-types"

/**
 * Phase-0 read access: route a community read through the routing directory when
 * the flag is on, otherwise use the legacy direct-open path. Returns a handle
 * the caller closes exactly like an `openCommunityDb` handle.
 *
 * This is intentionally a READ-only seam (callers needing writes/transactions
 * keep using `openCommunityDb`). It exists to exercise the resolver → directory
 * → backend-dispatch path in staging with zero behavior change: with every
 * community backfilled as `backend='turso'`, the routed path resolves the
 * directory and then opens the same Turso client the legacy path would.
 */

const ROUTING_FLAG = "COMMUNITY_READ_ROUTING_ENABLED"

export type CommunityReadHandle = {
  client: ReadClient
  close: () => void | Promise<void>
}

function routingEnabled(env: Env): boolean {
  const raw = (env as unknown as Record<string, unknown>)[ROUTING_FLAG]
  return String(raw ?? "").trim().toLowerCase() === "true"
}

function getResolver(): CommunityBindingResolver {
  // One process-wide resolver so its dual-TTL directory cache is shared across
  // requests (the whole point of caching control-plane routing lookups).
  return globalSingleton("communityBindingResolver", "default", () => new CommunityBindingResolver())
}

/**
 * Errors that mean "the directory has no usable entry for this community". We
 * fall back to the legacy Turso open rather than failing the read: the directory
 * is being backfilled, and a missing/stale row must not 404 a community that
 * predates it. Hard states (`community_decommissioned` 410, `binding_pending`
 * 503, `d1_backend_not_provisioned`) are NOT in this set — they propagate.
 */
const ROUTING_FALLBACK_CODES = new Set(["community_not_found", "binding_not_found", "binding_stale"])

function isRoutingFallback(error: unknown): boolean {
  return error instanceof HttpError && ROUTING_FALLBACK_CODES.has(error.code)
}

/**
 * The shard read invoker for PR1. The shard Worker hosting per-community D1
 * bindings is not deployed yet, so no community should resolve to
 * `backend='d1'`. Fail loud (retryable) rather than silently mis-serve, so a
 * premature d1 flip in the directory is caught instead of hidden.
 */
export const openShardReadClientNotProvisioned: CommunityReadInvoker = async (binding) => {
  throw new HttpError(
    503,
    "d1_backend_not_provisioned",
    `Community ${binding.communityId} routes to d1 but the shard read backend is not provisioned yet`,
    true,
  )
}

export type CommunityReadAccessDeps = {
  enabled: boolean
  resolver: CommunityBindingResolver
  controlPlane: DbExecutor
  openTursoReadClient: CommunityReadInvoker
  openShardReadClient: CommunityReadInvoker
  /** Legacy direct-open path (the current Turso open via `openCommunityDb`). */
  openLegacy: () => Promise<CommunityReadHandle>
}

/**
 * Pure routing decision (injectable for tests): flag off → legacy; flag on →
 * route through the directory, falling back to legacy on a routing miss.
 */
export async function resolveCommunityReadHandle(
  deps: CommunityReadAccessDeps,
  communityId: string,
): Promise<CommunityReadHandle> {
  if (!deps.enabled) {
    return deps.openLegacy()
  }
  try {
    const routed = await routeCommunityRead(deps, communityId)
    return { client: routed.client, close: () => routed.client.close?.() }
  } catch (error) {
    if (isRoutingFallback(error)) {
      return deps.openLegacy()
    }
    throw error
  }
}

export async function openCommunityReadClient(
  env: Env,
  repo: CommunityDatabaseBindingRepository,
  communityId: string,
): Promise<CommunityReadHandle> {
  const openLegacy = async (): Promise<CommunityReadHandle> => {
    const handle = await openCommunityDb(env, repo, communityId)
    return { client: handle.client, close: () => handle.close() }
  }

  // When the flag is off, never touch the control plane or resolver.
  if (!routingEnabled(env)) {
    return openLegacy()
  }

  const openTursoReadClient: CommunityReadInvoker = async (binding) => {
    // Confirmed Turso by the directory → open via the proven legacy path and
    // expose it as a ReadClient whose close() tears down the underlying handle.
    const handle = await openCommunityDb(env, repo, binding.communityId)
    return {
      execute: (statement) => handle.client.execute(statement),
      batch: (statements, mode) => handle.client.batch(statements, mode),
      close: () => handle.close(),
    }
  }

  return resolveCommunityReadHandle(
    {
      enabled: true,
      resolver: getResolver(),
      controlPlane: getControlPlaneClient(env),
      openTursoReadClient,
      openShardReadClient: openShardReadClientNotProvisioned,
      openLegacy,
    },
    communityId,
  )
}
