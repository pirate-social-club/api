import type { Client } from "../../sql-client"
import type { Env } from "../../../env"
import { getControlPlaneClient } from "../../runtime-deps"
import {
  findStuckD1ProvisioningBindings,
  upsertD1CommunityRoutingRow,
} from "../community-routing-repository"
import { getPrimaryCommunityDatabaseBinding } from "../community-read-repository"
import { persistProvisionedD1Binding } from "./repository"
import { runReconciliationSweep, type ReconcilerDeps, type StuckBinding } from "./reconciler"

/** Grace window: a 'provisioning' routing row is only reconciled after this long. */
export const RECONCILER_GRACE_MS = 15 * 60 * 1000

/** Cap on errors logged/returned per sweep so a mass-failure tick doesn't emit a huge payload. */
const MAX_LOGGED_ERRORS = 20

function shardDatabaseUrl(bindingName: string): string {
  return `d1://shard/${bindingName}`
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

  if (result.errors.length > 0) {
    console.error("[d1-reconciler] sweep errors", {
      scanned: result.scanned,
      advanced: result.advanced,
      released: result.released,
      errorCount: result.errors.length,
      sample: result.errors.slice(0, MAX_LOGGED_ERRORS),
    })
  } else if (result.scanned > 0) {
    console.log("[d1-reconciler] sweep", {
      scanned: result.scanned,
      advanced: result.advanced,
      released: result.released,
    })
  }
}
