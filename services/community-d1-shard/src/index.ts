import { WorkerEntrypoint } from "cloudflare:workers"
import type {
  ShardBatchReadRequest,
  ShardQueryResult,
  ShardReadRequest,
  ShardWriteRequest,
} from "@pirate/api-shared"
import type { Env } from "./env"
import { runShardBatch, runShardRead, runShardWrite } from "./shard-read"

/**
 * Community D1 shard (Turso→D1). Hosts per-community D1 bindings and exposes a
 * read RPC surface (PR2) + an atomic-batch write RPC (PR3) to the API Worker.
 *
 * Invariants (see [[turso-d1-pr2-design]]):
 *  1. `bindingName` is validated against this shard's OWN bound D1 namespaces
 *     (`resolveD1`) — a stale/poisoned control-plane row cannot point us at an
 *     arbitrary binding.
 *  2. Reads pass the read-only guard; writes pass the write guard (DML only, no
 *     DDL/PRAGMA) — both server-side. Writes are atomic D1 batches; there is no
 *     interactive-transaction method (D1 has none — the API buffers a write tx
 *     and commits it here as one batch).
 *
 * INVARIANT FOR NEW METHODS: any RPC method that touches a community's D1 MUST go
 * through runShardRead/runShardBatch/runShardWrite (or call assertCommunityBinding
 * + resolveD1 itself) — never resolveD1 alone, or the (communityId, bindingName)
 * authorization is bypassed.
 */
export class CommunityD1Shard extends WorkerEntrypoint<Env> {
  execute(input: ShardReadRequest): Promise<ShardQueryResult> {
    return runShardRead(this.env, input)
  }

  batch(input: ShardBatchReadRequest): Promise<ShardQueryResult[]> {
    return runShardBatch(this.env, input)
  }

  /** Atomic write batch (one buffered community write transaction). */
  batchWrite(input: ShardWriteRequest): Promise<ShardQueryResult[]> {
    return runShardWrite(this.env, input)
  }

  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ ok: true, service: "community-d1-shard" }), {
      headers: { "content-type": "application/json" },
    })
  }
}

export default CommunityD1Shard
