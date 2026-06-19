import { mapShardErrorToHttp, type ShardReadRpc, type ShardResult, type ShardSqlStatement } from "@pirate/api-shared"
import type { Env } from "../../env"
import type { DbExecutor } from "../db-helpers"
import { globalSingleton } from "../db-helpers"
import { HttpError } from "../errors"
import { getControlPlaneClient } from "../runtime-deps"
import type { Client, InStatement, ReadClient } from "../sql-client"
import type { ResolvedCommunityBinding } from "./community-binding-resolver"
import { CommunityBindingResolver } from "./community-binding-resolver"
import { makeCommunityD1Client } from "./community-d1-client"
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

export type CommunityReadHandle = {
  client: ReadClient
  close: () => void | Promise<void>
}

function routingEnabled(env: Env): boolean {
  // Typed access (Env declares COMMUNITY_READ_ROUTING_ENABLED) so a rename is a
  // compile error rather than a silent always-off. Undefined → off (safe).
  return String(env.COMMUNITY_READ_ROUTING_ENABLED ?? "").trim().toLowerCase() === "true"
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
 * Fallback shard invoker when no shard binding is bound on this Worker (e.g. a
 * community was flipped to `backend='d1'` before the shard service is deployed
 * to this env). Fail loud (retryable) rather than silently mis-serve.
 */
export const openShardReadClientNotProvisioned: CommunityReadInvoker = async (binding) => {
  throw new HttpError(
    503,
    "d1_backend_not_provisioned",
    `Community ${binding.communityId} routes to d1 but the shard read backend is not provisioned yet`,
    true,
  )
}

/** A ShardSqlStatement is structurally an InStatement; pass through unchanged. */
function toShardStatement(statement: InStatement | string): ShardSqlStatement | string {
  return statement as ShardSqlStatement | string
}

/**
 * Unwrap a `ShardResult<T>`: return the value on success, or throw an HttpError
 * with the original code on failure. The code is preserved across the
 * WorkerEntrypoint boundary because the shard returns errors as VALUES
 * (step 2.5), not thrown errors. The status/retryable mapping is the
 * single-sourced `mapShardErrorToHttp` in @pirate/api-shared — see §4.1.
 *
 * Throwing is the right shape for the DML read/write path: the consumer
 * just wants the value or a hard error. The provision() orchestrator
 * (step 4 of the D1-native workstream) is the exception: it needs to
 * BRANCH on the raw `ShardResult` (`.ok` / `.code`) to decide
 * retry-vs-fail-loud for the allocator, not throw-and-re-catch. So it
 * calls the shard's RPCs directly and inspects the discriminated union.
 */
function unwrap<T>(r: ShardResult<T>): T {
  if (r.ok) return r.value
  const { status, retryable } = mapShardErrorToHttp(r.code)
  throw new HttpError(status, r.code, r.message, retryable)
}

/**
 * PR2: real D1 read client backed by the shard Worker over the service-binding
 * RPC. Returns a `ReadClient` (no `transaction`) so the write surface is
 * unrepresentable here — writes remain PR3. The shard re-validates `bindingName`
 * and re-runs the read-only guard server-side; this side rejects write batch.
 */
export function makeShardReadClient(shard: ShardReadRpc, binding: ResolvedCommunityBinding): ReadClient {
  const bindingName = binding.bindingName
  if (!bindingName) {
    throw new HttpError(500, "binding_not_found", `d1 routing row for ${binding.communityId} has no binding_name`)
  }
  return {
    execute: async (statement) => {
      const r = await shard.execute({
        communityId: binding.communityId,
        bindingName,
        statement: toShardStatement(statement),
      })
      return unwrap(r)
    },
    batch: async (statements, mode) => {
      if (mode === "write") {
        throw new HttpError(400, "read_only_violation", "Write batch is not allowed on the D1 shard read client")
      }
      const r = await shard.batch({
        communityId: binding.communityId,
        bindingName,
        statements: statements.map((s) => toShardStatement(s) as ShardSqlStatement),
      })
      return unwrap(r)
    },
  }
}

/** Build the shard invoker for this Worker: real client if the shard binding is
 * present, else the fail-loud not-provisioned stub. */
function shardReadInvokerFor(env: Env): CommunityReadInvoker {
  const shard = env.COMMUNITY_D1_SHARD
  if (!shard) {
    return openShardReadClientNotProvisioned
  }
  return async (binding) => makeShardReadClient(shard, binding)
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
      openShardReadClient: shardReadInvokerFor(env),
      openLegacy,
    },
    communityId,
  )
}

export type CommunityWriteHandle = {
  client: Client
  close: () => void | Promise<void>
}

/**
 * PR3 cutover write/read access for a community. When the flag is on and the
 * community's routing row is `backend='d1'`, returns the D1-backed Client (reads
 * + buffered-batch writes via the shard). Otherwise — flag off, `backend='turso'`,
 * or a routing miss — returns the legacy Turso Client via `openCommunityDb`.
 *
 * This is the per-surface cutover seam: a call site opted into D1 writes uses
 * this instead of `openCommunityDb`. It is NOT a blanket `openCommunityDb`
 * replacement — only buffer-safe write surfaces (write-only tx bodies) may adopt
 * it until the result-dependent transactions are refactored.
 */
export type CommunityWriteAccessDeps = {
  enabled: boolean
  resolver: CommunityBindingResolver
  controlPlane: DbExecutor
  /** Open the D1-backed Client for a resolved d1 binding (throws if shard absent). */
  openD1: (binding: ResolvedCommunityBinding) => Client
  /** Legacy direct-open path (the current Turso open via `openCommunityDb`). */
  openLegacy: () => Promise<CommunityWriteHandle>
}

/**
 * Pure write-access decision (injectable for tests): flag off → legacy; flag on
 * → resolve the directory, d1 → D1 client, turso → legacy, routing miss → legacy.
 */
export async function resolveCommunityWriteHandle(
  deps: CommunityWriteAccessDeps,
  communityId: string,
): Promise<CommunityWriteHandle> {
  if (!deps.enabled) {
    return deps.openLegacy()
  }
  try {
    const binding = await deps.resolver.resolve(deps.controlPlane, communityId)
    if (binding.backend === "d1") {
      return { client: deps.openD1(binding), close: () => {} }
    }
    return deps.openLegacy()
  } catch (error) {
    if (isRoutingFallback(error)) {
      return deps.openLegacy()
    }
    throw error
  }
}

export async function openCommunityWriteClient(
  env: Env,
  repo: CommunityDatabaseBindingRepository,
  communityId: string,
): Promise<CommunityWriteHandle> {
  const openLegacy = async (): Promise<CommunityWriteHandle> => {
    const handle = await openCommunityDb(env, repo, communityId)
    return { client: handle.client, close: () => handle.close() }
  }

  // When the flag is off, never touch the control plane or resolver.
  if (!routingEnabled(env)) {
    return openLegacy()
  }

  return resolveCommunityWriteHandle(
    {
      enabled: true,
      resolver: getResolver(),
      controlPlane: getControlPlaneClient(env),
      openD1: (binding) => {
        const shard = env.COMMUNITY_D1_SHARD
        if (!shard) {
          throw new HttpError(
            503,
            "d1_backend_not_provisioned",
            `Community ${communityId} routes to d1 but the shard backend is not provisioned`,
            true,
          )
        }
        return makeCommunityD1Client(shard, binding)
      },
      openLegacy,
    },
    communityId,
  )
}
