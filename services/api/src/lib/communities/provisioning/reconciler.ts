import type {
  ShardAdminGetPoolRowResponse,
  ShardAdminListStaleUnloadedPoolRowsResponse,
  ShardAdminReleaseResponse,
  ShardAdminResetResponse,
  ShardResult,
} from "@pirate/api-shared"

/**
 * D1-native partial-failure reconciler (workstream step 5, design §6.1).
 *
 * The provision() sequence (communityD1Bind → loadSnapshot → routing flip) runs
 * across three stores with no cross-store transaction, so a crash can strand a
 * binding mid-flight. This sweep is the eventual-recovery backstop: it finds
 * routing rows stuck at `provisioning_state='provisioning'` past a grace window
 * and drives each to a terminal state.
 *
 * The authoritative signal is the pool row's `lastLoadedAt` (set only on a fully
 * successful snapshot load — §4.2), NOT a table-count heuristic:
 *   - lastLoadedAt set  → the load finished; the crash was on the final routing
 *                         flip. ADVANCE the routing row to 'ready'.
 *   - lastLoadedAt null → never fully loaded. RESET the community D1 + RELEASE
 *                         the pool binding (back into the §5 quarantine), and
 *                         mark the routing row 'degraded' so a later provision()
 *                         retry re-advances it with a fresh binding.
 *
 * Race handling: if RESET is refused with `shard_binding_loaded`, a concurrent
 * provision() retry completed the load between our GetPoolRow read and the reset
 * — so we ADVANCE instead of releasing. The shard's server-side reset guard
 * (f7042d3) is what makes this observable rather than a silent data-drop.
 */

export type StuckBinding = {
  communityId: string
  bindingName: string
  shardWorkerId: string
  region: string
}

export type StaleUnloadedPoolBinding = {
  communityId: string
  bindingName: string
  allocatedAt: string
}

export type ReconcilerDeps = {
  /** ISO timestamp for this sweep (stamped on writes; passed in for determinism). */
  now: string
  /** Control-plane read: routing rows at provisioning_state='provisioning' past the grace window. */
  findStuckProvisioningBindings(): Promise<StuckBinding[]>
  /** Shard admin RPC + control-plane filter: stale allocated pool rows with no active routing owner. */
  findUnclaimedStaleUnloadedPoolBindings(): Promise<ShardResult<ShardAdminListStaleUnloadedPoolRowsResponse>>
  /** Shard admin RPC: read the pool row (keyed off lastLoadedAt). */
  shardGetPoolRow(bindingName: string): Promise<ShardResult<ShardAdminGetPoolRowResponse>>
  /** Shard admin RPC: drop a never-loaded community's tables (refuses if loaded). */
  shardReset(bindingName: string): Promise<ShardResult<ShardAdminResetResponse>>
  /** Shard admin RPC: free a pool binding (starts the quarantine). */
  shardRelease(bindingName: string): Promise<ShardResult<ShardAdminReleaseResponse>>
  /** Control-plane write: flip routing row to 'ready' + re-mark the binding row. */
  advanceRoutingToReady(binding: StuckBinding): Promise<void>
  /** Control-plane write: mark routing row 'degraded' after a release (re-provisionable). */
  markRoutingDegraded(binding: StuckBinding, reason: string): Promise<void>
}

export type ReconcilerOutcome = "advanced" | "released" | "error"

export type ReconcilerResult = {
  scanned: number
  advanced: number
  released: number
  orphanReleased: number
  errors: Array<{ communityId: string; bindingName: string; reason: string }>
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runReconciliationSweep(deps: ReconcilerDeps): Promise<ReconcilerResult> {
  const stuck = await deps.findStuckProvisioningBindings()
  const result: ReconcilerResult = { scanned: stuck.length, advanced: 0, released: 0, orphanReleased: 0, errors: [] }

  for (const binding of stuck) {
    const outcome = await reconcileOne(deps, binding, result.errors).catch((error) => {
      result.errors.push({ communityId: binding.communityId, bindingName: binding.bindingName, reason: `exception: ${errorReason(error)}` })
      return "error" as const
    })
    if (outcome === "advanced") result.advanced++
    else if (outcome === "released") result.released++
  }

  const stale = await deps.findUnclaimedStaleUnloadedPoolBindings().catch((error) => ({
    ok: false as const,
    code: "exception",
    message: errorReason(error),
  }))
  if (!stale.ok) {
    result.errors.push({ communityId: "unknown", bindingName: "unknown", reason: `listStaleUnloadedPoolRows: ${stale.code}: ${stale.message}` })
    return result
  }
  result.scanned += stale.value.rows.length
  for (const binding of stale.value.rows) {
    const outcome = await reconcileUnclaimedStalePoolBinding(deps, binding, result.errors).catch((error) => {
      result.errors.push({ communityId: binding.communityId, bindingName: binding.bindingName, reason: `orphan exception: ${errorReason(error)}` })
      return "error" as const
    })
    if (outcome === "released") {
      result.released++
      result.orphanReleased++
    }
  }

  return result
}

async function reconcileOne(
  deps: ReconcilerDeps,
  binding: StuckBinding,
  errors: ReconcilerResult["errors"],
): Promise<ReconcilerOutcome> {
  const recordError = (reason: string): ReconcilerOutcome => {
    errors.push({ communityId: binding.communityId, bindingName: binding.bindingName, reason })
    return "error"
  }

  const poolRow = await deps.shardGetPoolRow(binding.bindingName)
  if (!poolRow.ok) return recordError(`getPoolRow: ${poolRow.code}`)
  const row = poolRow.value.row
  if (!row) return recordError("no pool row for stuck binding")

  // Loaded → the crash was on the final routing flip. Advance.
  if (row.lastLoadedAt != null) {
    await deps.advanceRoutingToReady(binding)
    return "advanced"
  }

  // Never loaded → reset + release. The reset guard may refuse if a concurrent
  // retry just finished the load; if so, advance instead of dropping.
  const reset = await deps.shardReset(binding.bindingName)
  if (!reset.ok) {
    if (reset.code === "shard_binding_loaded") {
      await deps.advanceRoutingToReady(binding)
      return "advanced"
    }
    return recordError(`reset: ${reset.code}`)
  }

  const release = await deps.shardRelease(binding.bindingName)
  if (!release.ok) return recordError(`release: ${release.code}`)

  await deps.markRoutingDegraded(binding, "d1_native provisioning stranded; binding released for re-provision")
  return "released"
}

async function reconcileUnclaimedStalePoolBinding(
  deps: ReconcilerDeps,
  binding: StaleUnloadedPoolBinding,
  errors: ReconcilerResult["errors"],
): Promise<ReconcilerOutcome> {
  const recordError = (reason: string): ReconcilerOutcome => {
    errors.push({ communityId: binding.communityId, bindingName: binding.bindingName, reason })
    return "error"
  }

  const reset = await deps.shardReset(binding.bindingName).catch((error) => ({
    ok: false as const,
    code: "exception",
    message: errorReason(error),
  }))
  if (!reset.ok) {
    if (reset.code === "shard_binding_loaded") {
      return recordError("orphan_pool_binding_loaded_before_reset")
    }
    return recordError(`orphan reset: ${reset.code}: ${reset.message}`)
  }

  const release = await deps.shardRelease(binding.bindingName).catch((error) => ({
    ok: false as const,
    code: "exception",
    message: errorReason(error),
  }))
  if (!release.ok) return recordError(`orphan release: ${release.code}: ${release.message}`)
  if (!release.value.released) return recordError("orphan release: already_free")

  return "released"
}
