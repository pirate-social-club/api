import type { Client } from "../../sql-client"
import type { Env } from "../../../env"
import { getControlPlaneClient } from "../../runtime-deps"
import { captureScheduledWarning } from "../../ops-alerts/scheduled"
import {
  findStuckD1ProvisioningBindings,
  upsertD1CommunityRoutingRow,
} from "../community-routing-repository"
import { getPrimaryCommunityDatabaseBinding } from "../community-read-repository"
import { persistProvisionedD1Binding } from "./repository"
import { runReconciliationSweep, type ReconcilerDeps, type ReconcilerResult, type StuckBinding } from "./reconciler"
import {
  type ConfiguredCommunityShard,
  listConfiguredCommunityShards,
} from "../community-shard-registry"

/** Grace window: a 'provisioning' routing row is only reconciled after this long. */
const RECONCILER_GRACE_MS = 15 * 60 * 1000

/** Cap on errors logged/returned per sweep so a mass-failure tick doesn't emit a huge payload. */
const MAX_LOGGED_ERRORS = 20
const TASK_NAME = "community_d1_provisioning_reconciler"

function shardDatabaseUrl(bindingName: string): string {
  return `d1://shard/${bindingName}`
}

async function findActivelyClaimedBindingNames(
  client: Client,
  bindingNames: string[],
  shardWorkerId?: string,
): Promise<Set<string>> {
  if (bindingNames.length === 0) return new Set()
  const placeholders = bindingNames.map((_, i) => `?${i + 1}`).join(", ")
  const shardPredicate = shardWorkerId ? `AND shard_worker_id = ?${bindingNames.length + 1}` : ""
  const result = await client.execute({
    sql: `
      SELECT binding_name
      FROM community_database_routing
      WHERE binding_name IN (${placeholders})
        ${shardPredicate}
        AND provisioning_state IN ('provisioning', 'ready')
        AND decommissioned_at IS NULL
    `,
    args: shardWorkerId ? [...bindingNames, shardWorkerId] : bindingNames,
  })
  return new Set((result.rows ?? []).map((row) => String((row as { binding_name?: unknown }).binding_name || "")))
}

/**
 * Wire the pure reconciler orchestrator to its three real surfaces.
 *
 * The advance path does BOTH writes the crashed provision() would have done:
 *   1. flip the routing row to 'ready', AND
 *   2. persist the binding row — replacing the `d1://pending-…invalid` sentinel
 *      with `d1://shard/<binding>`. Without (2), a routed read on the advanced
 *      community hits the pending-URL path and fails (the binding row never got
 *      its real URL). The pool row's `last_error` is already NULL here — the
 *      loadSnapshot success path clears it atomically with `last_loaded_at`.
 */
export function buildReconcilerDeps(
  env: Env,
  client: Client,
  nowIso: string,
  target?: ConfiguredCommunityShard,
): ReconcilerDeps {
  const adminToken = String(env.SHARD_ADMIN_TOKEN ?? "")
  const shard = target?.shard ?? env.COMMUNITY_D1_SHARD!
  const shardWorkerId = target?.shardWorkerId
  const cutoffIso = new Date(Date.parse(nowIso) - RECONCILER_GRACE_MS).toISOString()

  return {
    now: nowIso,
    findStuckProvisioningBindings: async () => {
      const rows = await findStuckD1ProvisioningBindings(client, cutoffIso)
      return shardWorkerId ? rows.filter((row) => row.shardWorkerId === shardWorkerId) : rows
    },
    findUnclaimedStaleUnloadedPoolBindings: async () => {
      const listed = await shard.communityD1ListStaleUnloadedPoolRows({
        adminToken,
        allocatedBefore: cutoffIso,
        limit: 50,
      })
      if (!listed.ok) return listed

      const claimed = await findActivelyClaimedBindingNames(
        client,
        listed.value.rows.map((row) => row.bindingName),
        shardWorkerId,
      )
      return {
        ok: true,
        value: {
          rows: listed.value.rows.filter((row) => !claimed.has(row.bindingName)),
        },
      }
    },
    shardGetPoolRow: (bindingName) => shard.communityD1GetPoolRow({ adminToken, bindingName }),
    shardReset: (bindingName) => shard.communityD1Reset({ adminToken, bindingName }),
    shardRelease: (bindingName, expectedCommunityId, expectedPoolVersion) => shard.communityD1Release({
      adminToken,
      bindingName,
      expectedCommunityId,
      expectedPoolVersion,
      now: nowIso,
    }),
    advanceRoutingToReady: async (binding: StuckBinding) => {
      await upsertD1CommunityRoutingRow(client, {
        communityId: binding.communityId,
        shardWorkerId: binding.shardWorkerId,
        bindingName: binding.bindingName,
        region: binding.region,
        now: nowIso,
        provisioningState: "ready",
      })
      const bindingRow = await getPrimaryCommunityDatabaseBinding(client, binding.communityId)
      if (bindingRow) {
        await persistProvisionedD1Binding(client, {
          communityDatabaseBindingId: bindingRow.community_database_binding_id,
          bindingName: binding.bindingName,
          databaseUrl: shardDatabaseUrl(binding.bindingName),
          region: binding.region,
          updatedAt: nowIso,
        })
      }
    },
    markRoutingDegraded: async (binding: StuckBinding) => {
      await upsertD1CommunityRoutingRow(client, {
        communityId: binding.communityId,
        shardWorkerId: binding.shardWorkerId,
        bindingName: binding.bindingName,
        region: binding.region,
        now: nowIso,
        provisioningState: "degraded",
      })
    },
  }
}

type ScheduledWarningReporter = typeof captureScheduledWarning

export async function reportD1ReconcilerSweepHealth(
  env: Env,
  result: ReconcilerResult,
  reportWarning: ScheduledWarningReporter = captureScheduledWarning,
): Promise<void> {
  // Always emit a one-line summary so the scheduled task is observable in tail
  // (a silent success is indistinguishable from "never ran" / misconfigured).
  console.log("[d1-reconciler] sweep", {
    scanned: result.scanned,
    advanced: result.advanced,
    released: result.released,
    orphanReleased: result.orphanReleased,
    errorCount: result.errors.length,
  })
  if (result.errors.length === 0) return

  const extra = {
    errorCount: result.errors.length,
    sample: result.errors.slice(0, MAX_LOGGED_ERRORS),
  }
  console.error("[d1-reconciler] sweep errors", extra)
  await reportWarning(
    env,
    "Community D1 provisioning reconciler reported errors",
    TASK_NAME,
    extra,
  )
}

/**
 * Scheduled-task entry for the D1-native reconciler sweep. Mounted in the API's
 * scheduled batch (which holds a DO lease — so this inherits single-flight, no
 * separate guard needed). Gated to a no-op unless the admin token and at least
 * one registered shard binding are present, so it is inert on workers that do
 * not host D1 reconciliation.
 *
 * Runs inside `withRequestControlPlaneClients` (the caller wraps it), so
 * `getControlPlaneClient(env)` is valid here.
 */
export async function reconcileScheduledD1Provisioning(env: Env): Promise<void> {
  if (!env.SHARD_ADMIN_TOKEN) {
    return // inert: this worker is not a D1 reconciler host
  }

  const configured = listConfiguredCommunityShards(env)
  const targets: Array<ConfiguredCommunityShard | undefined> = configured.length > 0
    ? configured
    : env.COMMUNITY_D1_SHARD
      ? [undefined]
      : []
  if (targets.length === 0) return

  const client = getControlPlaneClient(env)
  const nowIso = new Date().toISOString()
  const combined: ReconcilerResult = {
    scanned: 0,
    advanced: 0,
    released: 0,
    orphanReleased: 0,
    errors: [],
  }
  for (const target of targets) {
    const result = await runReconciliationSweep(buildReconcilerDeps(env, client, nowIso, target))
    combined.scanned += result.scanned
    combined.advanced += result.advanced
    combined.released += result.released
    combined.orphanReleased += result.orphanReleased
    combined.errors.push(...result.errors.map((error) => ({
      ...error,
      reason: target ? `[${target.shardWorkerId}] ${error.reason}` : error.reason,
    })))
  }
  await reportD1ReconcilerSweepHealth(env, combined)
}
