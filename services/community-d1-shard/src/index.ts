import { WorkerEntrypoint } from "cloudflare:workers"
import type { ShardBatchReadRequest, ShardQueryResult, ShardReadRequest } from "@pirate/api-shared"
import type { Env } from "./env"
import { runShardBatch, runShardRead } from "./shard-read"

/**
 * Community D1 shard (Turso→D1 PR2). Hosts per-community D1 bindings and exposes
 * a READ-ONLY RPC surface to the API Worker via service binding.
 *
 * Two invariants (see [[turso-d1-pr2-design]]):
 *  1. `bindingName` is validated against this shard's OWN bound D1 namespaces
 *     (`resolveD1`) — a stale/poisoned control-plane row cannot point us at an
 *     arbitrary binding.
 *  2. Every statement passes the shared read-only guard server-side. There is no
 *     write/transaction method on this class; the write path is PR3.
 *
 * INVARIANT FOR NEW METHODS: any RPC method that touches a community's D1 MUST go
 * through runShardRead/runShardBatch (or call assertCommunityBinding + resolveD1
 * itself) — never resolveD1 alone, or the (communityId, bindingName) authorization
 * is bypassed.
 */
export class CommunityD1Shard extends WorkerEntrypoint<Env> {
  execute(input: ShardReadRequest): Promise<ShardQueryResult> {
    return runShardRead(this.env, input)
  }

  batch(input: ShardBatchReadRequest): Promise<ShardQueryResult[]> {
    return runShardBatch(this.env, input)
  }

  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ ok: true, service: "community-d1-shard" }), {
      headers: { "content-type": "application/json" },
    })
  }
}

export default CommunityD1Shard
