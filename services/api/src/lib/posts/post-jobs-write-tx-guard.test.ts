import { describe, expect, test } from "bun:test"
import {
  isWriteAllowedStatement,
  type ShardRpc,
  type ShardSqlStatement,
  type ShardResult,
  type ShardQueryResult,
} from "@pirate/api-shared"
import { makeCommunityD1Client } from "../communities/community-d1-client"
import type { ResolvedCommunityBinding } from "../communities/community-binding-resolver"
import type { PostWriteDraft } from "./community-post-create-store"
import {
  enqueueEmbedHydrateIfNeeded,
  enqueuePostLabelIfNeeded,
  enqueuePostTranslationPrewarmJobs,
} from "./post-jobs"

// Regression guard for the D1 cutover bug: createPost enqueues its jobs INSIDE a
// transaction("write"), which the routed D1 client buffers into one atomic
// shard.batchWrite(). enqueueCommunityJob's dedup lookup is a SELECT, and the
// shard write guard (isWriteAllowedStatement) rejects any non-DML in that batch
// with "Statement rejected by shard write guard: SELECT". The fix is dedupe:false
// at each create-time enqueue site. This test drives the REAL BufferingD1Write-
// Transaction (via makeCommunityD1Client) against a fake shard that applies the
// REAL guard to every buffered statement — exactly the boundary that broke in prod.

const COMMUNITY_ID = "cmt_pilot"

function bindingFor(communityId: string): ResolvedCommunityBinding {
  return {
    communityId,
    backend: "d1",
    provisioningState: "ready",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_PILOT",
    region: "enam",
    decommissionedAt: null,
  } as ResolvedCommunityBinding
}

/**
 * A fake shard whose batchWrite applies the real `isWriteAllowedStatement` guard
 * to each statement — i.e. the exact validation the deployed shard runs in
 * `runShardWrite`. A buffered SELECT therefore fails here just as it does in prod.
 * Captures every statement it accepts so the test can assert no read leaked in.
 */
function makeGuardedFakeShard() {
  const seen: ShardSqlStatement[] = []
  const shard = {
    async batchWrite(input: {
      statements: ShardSqlStatement[]
    }): Promise<ShardResult<ShardQueryResult[]>> {
      for (const statement of input.statements) {
        if (!isWriteAllowedStatement(statement.sql)) {
          return {
            ok: false,
            code: "shard_write_not_allowed",
            message: `Statement rejected by shard write guard: ${statement.sql}`,
          }
        }
      }
      seen.push(...input.statements)
      return { ok: true, value: input.statements.map(() => ({ rows: [] })) }
    },
  } as unknown as ShardRpc
  return { shard, seen }
}

function linkDraft(): PostWriteDraft {
  return {
    post_id: "pst_link_1",
    post_type: "link",
    status: "published",
    title: "A link",
    body: null,
    caption: null,
    link_url: "https://example.com/article",
    // machine_allowed + a source language unlike the prewarm locales triggers the
    // translation prewarm enqueue too — exercises all three create-time helpers.
    source_language: "en",
    translation_policy: "machine_allowed",
    embeds: null,
    link_enrichment_snapshot_json: null,
  } as PostWriteDraft
}

describe("create-time job enqueue inside a D1 write transaction", () => {
  test("link createPost enqueues commit cleanly through the shard write guard (no buffered SELECT)", async () => {
    const { shard, seen } = makeGuardedFakeShard()
    const client = makeCommunityD1Client(shard, bindingFor(COMMUNITY_ID))
    const post = linkDraft()
    const createdAt = "2026-06-22T00:00:00.000Z"

    const tx = await client.transaction("write")
    // Mirrors post-service.ts createPost: embed-hydrate (link-only), label, and
    // translation-prewarm jobs are all enqueued inside the buffered write tx.
    await enqueueEmbedHydrateIfNeeded({ client: tx, communityId: COMMUNITY_ID, post, createdAt })
    await enqueuePostLabelIfNeeded({
      client: tx,
      communityId: COMMUNITY_ID,
      post,
      createdAt,
      community: {
        label_policy: {
          label_enabled: true,
          definitions: [{ status: "active" }],
        },
      } as never,
    })
    await enqueuePostTranslationPrewarmJobs({ client: tx, communityId: COMMUNITY_ID, post, createdAt })

    // The bug surfaced here: commit() flushes the buffer to shard.batchWrite,
    // where a buffered SELECT would be rejected. With dedupe:false it must not throw.
    await expect(tx.commit()).resolves.toBeUndefined()

    // And every statement that reached the shard must be a write — no dedup SELECT leaked in.
    expect(seen.length).toBeGreaterThan(0)
    for (const statement of seen) {
      expect(isWriteAllowedStatement(statement.sql)).toBe(true)
    }
  })
})
