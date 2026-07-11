import { mapShardErrorToHttp, type ShardReadRpc, type ShardResult, type ShardSqlStatement } from "@pirate/api-shared"
import type { Env } from "../../env"
import type { DbExecutor } from "../db-helpers"
import { globalSingleton } from "../db-helpers"
import { HttpError } from "../errors"
import { getControlPlaneClient } from "../runtime-deps"
import type { Client, InStatement, ReadClient } from "../sql-client"
import type { Transaction } from "../sql-client"
import type { ResolvedCommunityBinding } from "./community-binding-resolver"
import { CommunityBindingResolver } from "./community-binding-resolver"
import { openCommunityDb } from "./community-db-factory"
import { makeCommunityD1Client } from "./community-d1-client"
import {
  routeCommunityRead,
  invalidateOnStaleBindingError,
  type CommunityReadInvoker,
} from "./community-read-router"
import type { CommunityDatabaseBindingRepository } from "./community-repository-types"

export type CommunityReadHandle = {
  client: ReadClient
  close: () => void | Promise<void>
}

function getResolver(): CommunityBindingResolver {
  // One process-wide resolver so its dual-TTL directory cache is shared across
  // requests (the whole point of caching control-plane routing lookups).
  return globalSingleton("communityBindingResolver", "default", () => new CommunityBindingResolver())
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
 * Real D1 read client backed by the shard Worker over the service-binding
 * RPC. Returns a `ReadClient` (no `transaction`) so the write surface is
 * unrepresentable here. The shard re-validates `bindingName`
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

function shouldUseTestLocalCommunityDb(env: Env): boolean {
  return env.ENVIRONMENT === "test" && !env.COMMUNITY_D1_SHARD
}

async function openTestLocalCommunityDb(
  env: Env,
  repo: CommunityDatabaseBindingRepository,
  communityId: string,
): Promise<CommunityWriteHandle> {
  const handle = await openCommunityDb(env, repo, communityId)
  return { client: handle.client, close: () => handle.close() }
}

export type CommunityReadAccessDeps = {
  resolver: CommunityBindingResolver
  controlPlane: DbExecutor
  openShardReadClient: CommunityReadInvoker
}

export async function resolveCommunityReadHandle(
  deps: CommunityReadAccessDeps,
  communityId: string,
): Promise<CommunityReadHandle> {
  const routed = await routeCommunityRead(deps, communityId)
  const client: ReadClient = {
    ...routed.client,
    execute: (statement) =>
      invalidateOnStaleBindingError(deps.resolver, communityId, () => routed.client.execute(statement)),
    batch: (statements, mode) =>
      invalidateOnStaleBindingError(deps.resolver, communityId, () => routed.client.batch(statements, mode)),
    close: () => routed.client.close?.(),
  }
  return { client, close: () => client.close?.() }
}

export async function openCommunityReadClient(
  env: Env,
  repo: CommunityDatabaseBindingRepository,
  communityId: string,
): Promise<CommunityReadHandle> {
  if (shouldUseTestLocalCommunityDb(env)) {
    return openTestLocalCommunityDb(env, repo, communityId)
  }

  return resolveCommunityReadHandle(
    {
      resolver: getResolver(),
      controlPlane: getControlPlaneClient(env),
      openShardReadClient: shardReadInvokerFor(env),
    },
    communityId,
  )
}

export type CommunityWriteHandle = {
  client: Client
  close: () => void | Promise<void>
}

/**
 * D1 read/write access for a community. Routing is authoritative: the resolver
 * must return a ready D1 route, then the shard-backed Client handles reads and
 * buffered-batch writes.
 */
export type CommunityWriteAccessDeps = {
  resolver: CommunityBindingResolver
  controlPlane: DbExecutor
  /** Open the D1-backed Client for a resolved d1 binding (throws if shard absent). */
  openD1: (binding: ResolvedCommunityBinding) => Client
}

export async function resolveCommunityWriteHandle(
  deps: CommunityWriteAccessDeps,
  communityId: string,
): Promise<CommunityWriteHandle> {
  const binding = await deps.resolver.resolve(deps.controlPlane, communityId)
  const routed = deps.openD1(binding)
  const guard = <T>(operation: () => Promise<T>) =>
    invalidateOnStaleBindingError(deps.resolver, communityId, operation)
  const wrapTransaction = (transaction: Transaction): Transaction => ({
    execute: (statement) => guard(() => transaction.execute(statement)),
    batch: (statements, mode) => guard(() => transaction.batch(statements, mode)),
    commit: () => guard(() => transaction.commit()),
    rollback: () => guard(() => transaction.rollback()),
    close: () => transaction.close(),
  })
  const client: Client = {
    ...routed,
    execute: (statement) => guard(() => routed.execute(statement)),
    batch: (statements, mode) => guard(() => routed.batch(statements, mode)),
    transaction: async (mode) => wrapTransaction(await guard(() => routed.transaction(mode))),
    close: () => routed.close?.(),
  }
  return { client, close: () => client.close?.() }
}

export async function openCommunityWriteClient(
  env: Env,
  repo: CommunityDatabaseBindingRepository,
  communityId: string,
): Promise<CommunityWriteHandle> {
  if (shouldUseTestLocalCommunityDb(env)) {
    return openTestLocalCommunityDb(env, repo, communityId)
  }

  return resolveCommunityWriteHandle(
    {
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
    },
    communityId,
  )
}
