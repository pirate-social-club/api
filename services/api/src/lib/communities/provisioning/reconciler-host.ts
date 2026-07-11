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

/** Grace window: a 'provisioning' routing row is only reconciled after this long. */
const RECONCILER_GRACE_MS = 15 * 60 * 1000

/** Cap on errors logged/returned per sweep so a mass-failure tick doesn't emit a huge payload. */
const MAX_LOGGED_ERRORS = 20
const TASK_NAME = "community_d1_provisioning_reconciler"

function shardDatabaseUrl(bindingName: string): string {
  return `d1://shard/${bindingName}`
}

async function findActivelyClaimedBindingNames(client: Client, bindingNames: string[]): Promise<Set<string>> {
  if (bindingNames.length === 0) return new Set()
  const placeholders = bindingNames.map((_, i) => `?${i + 1}`).join(", ")
  const result = await client.execute({
    sql: `
      SELECT binding_name
      FROM community_database_routing
      WHERE binding_name IN (${placeholders})
        AND provisioning_state IN ('provisioning', 'ready')
        AND decommissioned_at IS NULL
    `,
    args: bindingNames,
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
export function buildReconcilerDeps(env: Env, client: Client, nowIso: string): ReconcilerDeps {
  const adminToken = String(env.SHARD_ADMIN_TOKEN ?? "")
  const shard = env.COMMUNITY_D1_SHARD!
  const cutoffIso = new Date(Date.parse(nowIso) - RECONCILER_GRACE_MS).toISOString()

  return {
    now: nowIso,
    findStuckProvisioningBindings: () => findStuckD1ProvisioningBindings(client, cutoffIso),
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
    shardRelease: (bindingName) => shard.communityD1Release({ adminToken, bindingName, now: nowIso }),
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
 * separate guard needed). Gated to a no-op unless BOTH the admin token and the
 * shard binding are present, so it is inert on every worker except the D1
 * staging worker (and, later, a dedicated prod reconciler).
 *
 * Runs inside `withRequestControlPlaneClients` (the caller wraps it), so
 * `getControlPlaneClient(env)` is valid here.
 */
export async function reconcileScheduledD1Provisioning(env: Env): Promise<void> {
  if (!env.SHARD_ADMIN_TOKEN || !env.COMMUNITY_D1_SHARD) {
    return // inert: this worker is not a D1 reconciler host
  }

  const client = getControlPlaneClient(env)
  const nowIso = new Date().toISOString()
  const deps = buildReconcilerDeps(env, client, nowIso)
  const result = await runReconciliationSweep(deps)
  await reportD1ReconcilerSweepHealth(env, result)
}
