import { WorkerEntrypoint } from "cloudflare:workers"
import type {
  ShardBatchReadRequest,
  ShardBindRequest,
  ShardBindResponse,
  ShardLoadSnapshotRequest,
  ShardLoadSnapshotResponse,
  ShardQueryResult,
  ShardReadRequest,
  ShardResult,
  ShardWriteRequest,
} from "@pirate/api-shared"
import type { Env } from "./env"
import {
  runShardBatch,
  runShardBind,
  runShardLoadSnapshot,
  runShardRead,
  runShardWrite,
} from "./shard-read"

/**
 * Community D1 shard (Turso→D1). Hosts per-community D1 bindings and exposes a
 * read RPC surface (PR2) + an atomic-batch write RPC (PR3) + a binding
 * allocator RPC (step 2) + a snapshot-loader RPC (step 3) to the API Worker.
 *
 * All RPCs return `ShardResult<T>` (a discriminated union) instead of throwing
 * on expected failures, so error codes survive the WorkerEntrypoint RPC
 * boundary losslessly — see D1-NATIVE-PROVISIONING-DESIGN.md §4.1 acceptance
 * criteria (the API must distinguish `shard_pool_write_conflict` from
 * `shard_pool_exhausted` to implement its retry semantics).
 *
 * Invariants (see [[turso-d1-pr2-design]]):
 *  1. `bindingName` is validated against this shard's OWN bound D1 namespaces
 *     (`resolveD1`) — a stale/poisoned control-plane row cannot point us at an
 *     arbitrary binding.
 *  2. Reads pass the read-only guard; writes pass the write guard (DML only, no
 *     DDL/PRAGMA) — both server-side. Writes are atomic D1 batches; there is no
 *     interactive-transaction method (D1 has none — the API buffers a write tx
 *     and commits it here as one batch).
 *  3. The (communityId, bindingName) allowlist is also re-validated against
 *     `d1_pool` (the shard-owned pool D1) via `assertCommunityBinding` — the
 *     control-plane routing row is never trusted on its own. (Step 1.)
 *  4. The bootstrap path (communityD1LoadSnapshot) re-validates the pool row
 *     before any write (the §4.2 invariant against release+reallocate) and
 *     uses `isBootstrapAllowedStatement` (wider than the write guard — permits
 *     CREATE TABLE IF NOT EXISTS). (Step 3.)
 *
 * INVARIANT FOR NEW METHODS: any RPC method that touches a community's D1 MUST go
 * through runShardRead/runShardBatch/runShardWrite/runShardLoadSnapshot (or
 * call assertCommunityBinding + resolveD1 itself) — never resolveD1 alone, or
 * the (communityId, bindingName) authorization is bypassed.
 */
export class CommunityD1Shard extends WorkerEntrypoint<Env> {
  execute(input: ShardReadRequest): Promise<ShardResult<ShardQueryResult>> {
    return runShardRead(this.env, input)
  }

  batch(input: ShardBatchReadRequest): Promise<ShardResult<ShardQueryResult[]>> {
    return runShardBatch(this.env, input)
  }

  /** Atomic write batch (one buffered community write transaction). */
  batchWrite(input: ShardWriteRequest): Promise<ShardResult<ShardQueryResult[]>> {
    return runShardWrite(this.env, input)
  }

  /**
   * Step 2 of the D1-native workstream: allocate a D1 binding from the shard's
   * pool for `communityId`. Idempotent — repeated calls for the same community
   * return the same binding, with `allocated: false` on subsequent calls.
   */
  communityD1Bind(input: ShardBindRequest): Promise<ShardResult<ShardBindResponse>> {
    return runShardBind(this.env, input)
  }

  /**
   * Step 3 of the D1-native workstream: load the community schema + snapshot
   * rows into the allocated D1 binding. Idempotent — re-running on an
   * already-loaded binding is a no-op (`loaded: false`).
   */
  communityD1LoadSnapshot(
    input: ShardLoadSnapshotRequest,
  ): Promise<ShardResult<ShardLoadSnapshotResponse>> {
    return runShardLoadSnapshot(this.env, input)
  }

  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ ok: true, service: "community-d1-shard" }), {
      headers: { "content-type": "application/json" },
    })
  }
}

export default CommunityD1Shard
