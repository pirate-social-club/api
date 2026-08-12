#!/usr/bin/env bun

import type { Env } from "../src/env"
import {
  EFP_INDEXER_CHAINS,
  scanEfpChainOnce,
  type EfpIndexerChainConfig,
} from "../src/lib/efp-indexer/scanner"
import { getControlPlaneClient, withRequestControlPlaneClients } from "../src/lib/runtime-deps"
import {
  deriveAuthoritativeFollowersEdges,
  findEfpFollowersAffectedByChain,
  refreshEfpProjectionAvailability,
  replaceFollowersEffectiveEdgesInTransaction,
} from "../src/lib/efp-indexer/materializer"
import { readEfpIndexerCursor } from "../src/lib/efp-indexer/repository"
import { withTransaction } from "../src/lib/transactions"
import type { Address, Hex } from "viem"

const FINALIZATION_FOLLOWER_BATCH_SIZE = 100
const FINALIZATION_INSERT_BATCH_SIZE = 1_000

function positiveBatchLimit(value: string | undefined): number {
  if (value == null) return 10_000
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Optional batch limit must be a positive integer")
  }
  return parsed
}

function blockSpan(value: string | undefined, variableName = "EFP_BACKFILL_BLOCK_SPAN"): bigint | undefined {
  if (!value) return undefined
  if (!/^\d+$/u.test(value)) throw new Error(`${variableName} must be a positive integer`)
  const parsed = BigInt(value)
  if (parsed <= 0n || parsed > 1_000_000n) {
    throw new Error(`${variableName} must be between 1 and 1000000`)
  }
  return parsed
}

export async function finalizeDeferredProjection(input: {
  client: ReturnType<typeof getControlPlaneClient>
  config: EfpIndexerChainConfig
  followerBatchSize?: number
  maxFollowerBatches?: number
}): Promise<boolean> {
  const cursor = await readEfpIndexerCursor(input.client, input.config.chainId)
  if (!cursor || cursor.indexedThroughBlock < cursor.safeHeadBlock) {
    throw new Error(`Cannot finalize EFP ${input.config.name}: raw index is not caught up`)
  }
  const slots = await input.client.execute({
    sql: `
      SELECT COUNT(*) AS slot_count
      FROM (
        SELECT DISTINCT contract_address, slot
        FROM efp_list_ops
        WHERE chain_id = ?1
      ) distinct_slots
    `,
    args: [input.config.chainId],
  })
  const slotCount = Number(slots.rows[0]?.slot_count ?? 0)
  const targetBlock = cursor.indexedThroughBlock
  const targetBlockHash = cursor.indexedThroughBlockHash.toLowerCase() as Hex
  const job = await withTransaction(input.client, "write", async (tx) => {
    const existing = await tx.execute({
      sql: `
        SELECT target_block, target_block_hash, projection_revision,
               status, total_followers, processed_followers
        FROM efp_follow_projection_backfills
        WHERE chain_id = ?1
      `,
      args: [input.config.chainId],
    })
    const row = existing.rows[0]
    if (
      row
      && (
        BigInt(String(row.target_block)) !== targetBlock
        || String(row.target_block_hash).toLowerCase() !== targetBlockHash
      )
    ) {
      await tx.execute({
        sql: "DELETE FROM efp_follow_projection_backfills WHERE chain_id = ?1",
        args: [input.config.chainId],
      })
    } else if (row) {
      const now = new Date().toISOString()
      await tx.execute({
        sql: `
          UPDATE efp_follow_projection_backfills
          SET status = 'running', last_error = NULL,
              completed_at = NULL, updated_at = ?2
          WHERE chain_id = ?1
        `,
        args: [input.config.chainId, now],
      })
      return {
        projectionRevision: BigInt(String(row.projection_revision)),
        totalFollowers: Number(row.total_followers),
        processedFollowers: Number(row.processed_followers),
      }
    }

    const state = await tx.execute(
      "SELECT projection_revision FROM efp_follow_projection_state WHERE projection_key = 'effective-graph'",
    )
    const projectionRevision = BigInt(String(state.rows[0]?.projection_revision ?? "0")) + 1n
    const affectedAccounts = await findEfpFollowersAffectedByChain({
      tx,
      chainId: input.config.chainId,
    })
    const now = new Date().toISOString()
    await tx.execute({
      sql: `
        INSERT INTO efp_follow_projection_backfills (
          chain_id, target_block, target_block_hash, projection_revision,
          status, total_followers, processed_followers,
          last_error, started_at, updated_at, completed_at
        ) VALUES (?1, ?2, ?3, ?4, 'running', ?5, 0, NULL, ?6, ?6, NULL)
      `,
      args: [
        input.config.chainId,
        targetBlock.toString(),
        targetBlockHash,
        projectionRevision.toString(),
        affectedAccounts.length,
        now,
      ],
    })
    for (let offset = 0; offset < affectedAccounts.length; offset += FINALIZATION_INSERT_BATCH_SIZE) {
      const batch = affectedAccounts.slice(offset, offset + FINALIZATION_INSERT_BATCH_SIZE)
      const args: (number | string)[] = []
      const values = batch.map((follower) => {
        const index = args.length
        args.push(input.config.chainId, targetBlock.toString(), follower)
        return `(?${index + 1}, ?${index + 2}, ?${index + 3})`
      }).join(", ")
      await tx.execute({
        sql: `
          INSERT INTO efp_follow_projection_backfill_followers (
            chain_id, target_block, follower_address
          ) VALUES ${values}
        `,
        args,
      })
    }
    return {
      projectionRevision,
      totalFollowers: affectedAccounts.length,
      processedFollowers: 0,
    }
  })

  console.info(JSON.stringify({
    component: "efp_indexer",
    operation: `finalize_${input.config.name}_projection_started`,
    target_block: targetBlock.toString(),
    total_followers: job.totalFollowers,
    processed_followers: job.processedFollowers,
  }))

  let completedBatches = 0
  try {
    for (;;) {
      if (
        input.maxFollowerBatches != null
        && completedBatches >= input.maxFollowerBatches
      ) return false
      const summary = await withTransaction(input.client, "write", async (tx) => {
        const pending = await tx.execute({
          sql: `
            SELECT follower_address
            FROM efp_follow_projection_backfill_followers
            WHERE chain_id = ?1 AND target_block = ?2 AND processed_at IS NULL
            ORDER BY follower_address
            LIMIT ?3
          `,
          args: [
            input.config.chainId,
            targetBlock.toString(),
            input.followerBatchSize ?? FINALIZATION_FOLLOWER_BATCH_SIZE,
          ],
        })
        const followers = pending.rows.flatMap((row) =>
          typeof row.follower_address === "string"
            ? [row.follower_address.toLowerCase() as Address]
            : [],
        )
        if (followers.length === 0) return null
        const now = new Date().toISOString()
        const edgesByFollower = await deriveAuthoritativeFollowersEdges(tx, followers)
        await replaceFollowersEffectiveEdgesInTransaction({
          tx,
          edgesByFollower,
          projectionRevision: job.projectionRevision,
          now,
        })
        const placeholders = followers.map((_, index) => `?${index + 3}`).join(", ")
        await tx.execute({
          sql: `
            UPDATE efp_follow_projection_backfill_followers
            SET processed_at = ?1
            WHERE chain_id = ?2
              AND target_block = ?${followers.length + 3}
              AND follower_address IN (${placeholders})
          `,
          args: [
            now,
            input.config.chainId,
            ...followers,
            targetBlock.toString(),
          ],
        })
        const progress = await tx.execute({
          sql: `
            UPDATE efp_follow_projection_backfills
            SET processed_followers = processed_followers + ?2,
                updated_at = ?3
            WHERE chain_id = ?1
            RETURNING processed_followers
          `,
          args: [input.config.chainId, followers.length, now],
        })
        return {
          batchFollowers: followers.length,
          processedFollowers: Number(progress.rows[0]?.processed_followers ?? 0),
        }
      })
      if (!summary) break
      completedBatches += 1
      console.info(JSON.stringify({
        component: "efp_indexer",
        operation: `finalize_${input.config.name}_projection_batch`,
        ...summary,
        total_followers: job.totalFollowers,
      }))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const now = new Date().toISOString()
    await withTransaction(input.client, "write", async (tx) => {
      await tx.execute({
        sql: `
          UPDATE efp_follow_projection_backfills
          SET status = 'failed', last_error = ?2, updated_at = ?3
          WHERE chain_id = ?1
        `,
        args: [input.config.chainId, message, now],
      })
      await tx.execute({
        sql: `
          UPDATE efp_follow_projection_state
          SET status = 'unavailable', last_error = ?1,
              status_changed_at = CASE WHEN status <> 'unavailable' THEN ?2 ELSE status_changed_at END,
              updated_at = ?2
          WHERE projection_key = 'effective-graph'
        `,
        args: [message, now],
      })
    })
    throw error
  }

  const now = new Date().toISOString()
  await withTransaction(input.client, "write", async (tx) => {
    const pending = await tx.execute({
      sql: `
        SELECT COUNT(*) AS pending_count
        FROM efp_follow_projection_backfill_followers
        WHERE chain_id = ?1 AND target_block = ?2 AND processed_at IS NULL
      `,
      args: [input.config.chainId, targetBlock.toString()],
    })
    if (Number(pending.rows[0]?.pending_count ?? 0) !== 0) {
      throw new Error(`Cannot finalize EFP ${input.config.name}: follower batches remain`)
    }
    const completed = await tx.execute({
      sql: `
        UPDATE efp_follow_projection_backfills
        SET status = 'complete', last_error = NULL,
            completed_at = ?5, updated_at = ?5
        WHERE chain_id = ?1
          AND target_block = ?2
          AND target_block_hash = ?3
          AND projection_revision = ?4
          AND processed_followers = total_followers
      `,
      args: [
        input.config.chainId,
        targetBlock.toString(),
        targetBlockHash,
        job.projectionRevision.toString(),
        now,
      ],
    })
    if (completed.rowsAffected !== 1) {
      throw new Error(
        `Cannot watermark EFP ${input.config.name}: completed backfill evidence is missing`,
      )
    }
    const watermarked = await tx.execute({
      sql: `
        INSERT INTO efp_follow_projection_chain_watermarks (
          chain_id, applied_through_block, applied_through_block_hash,
          projection_revision, last_successful_at, updated_at
        )
        SELECT chain_id, target_block, target_block_hash,
               projection_revision, ?5, ?5
        FROM efp_follow_projection_backfills
        WHERE chain_id = ?1
          AND target_block = ?2
          AND target_block_hash = ?3
          AND projection_revision = ?4
          AND status = 'complete'
          AND processed_followers = total_followers
        ON CONFLICT(chain_id) DO UPDATE SET
          applied_through_block = excluded.applied_through_block,
          applied_through_block_hash = excluded.applied_through_block_hash,
          projection_revision = excluded.projection_revision,
          last_successful_at = excluded.last_successful_at,
          updated_at = excluded.updated_at
      `,
      args: [
        input.config.chainId,
        targetBlock.toString(),
        targetBlockHash,
        job.projectionRevision.toString(),
        now,
      ],
    })
    if (watermarked.rowsAffected !== 1) {
      throw new Error(
        `Cannot watermark EFP ${input.config.name}: completed backfill evidence is missing`,
      )
    }
    await tx.execute({
      sql: `
        UPDATE efp_follow_projection_state
        SET projection_revision = ?1, last_error = NULL, updated_at = ?2
        WHERE projection_key = 'effective-graph'
      `,
      args: [job.projectionRevision.toString(), now],
    })
  })
  await refreshEfpProjectionAvailability({
    client: input.client,
    projectionRevision: job.projectionRevision,
    now,
  })
  console.info(JSON.stringify({
    component: "efp_indexer",
    operation: `finalize_${input.config.name}_projection`,
    slot_count: slotCount,
    applied_through_block: cursor.indexedThroughBlock.toString(),
  }))
  return true
}

async function main(): Promise<void> {
  const env = process.env as unknown as Env
  const chainName = String(process.env.EFP_BACKFILL_CHAIN ?? "base").trim()
  const config = EFP_INDEXER_CHAINS[chainName as EfpIndexerChainConfig["name"]]
  if (!config) throw new Error("EFP_BACKFILL_CHAIN must be base, optimism, or ethereum")
  const rpcUrl = String(
    config.name === "base"
      ? env.BASE_MAINNET_RPC_URL
      : config.name === "optimism"
        ? env.OPTIMISM_MAINNET_RPC_URL
        : env.ETHEREUM_RPC_URL,
  ).trim()
  if (!env.CONTROL_PLANE_DATABASE_URL) throw new Error("CONTROL_PLANE_DATABASE_URL is required")
  if (!rpcUrl) throw new Error(`RPC URL is required for EFP ${config.name} backfill`)
  const batchLimit = positiveBatchLimit(process.argv[2])
  const requestedBlockSpan = blockSpan(process.env.EFP_BACKFILL_BLOCK_SPAN) ?? 100_000n
  const requestedRpcLogRange = blockSpan(
    process.env.EFP_BACKFILL_RPC_LOG_RANGE,
    "EFP_BACKFILL_RPC_LOG_RANGE",
  )
  const scanConfig = requestedRpcLogRange
    ? { ...config, rpcLogRange: requestedRpcLogRange }
    : config
  const deferProjection = String(process.env.EFP_BACKFILL_DEFER_PROJECTION ?? "").trim().toLowerCase() === "true"

  await withRequestControlPlaneClients(async () => {
    const client = getControlPlaneClient(env)
    let consecutiveRateLimits = 0
    for (let batch = 1; batch <= batchLimit;) {
      let summary
      try {
        summary = await scanEfpChainOnce({
          client,
          rpcUrl,
          config: scanConfig,
          blockSpan: requestedBlockSpan,
          deferProjection,
        })
        consecutiveRateLimits = 0
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
        if (!message.includes("rate limit") || consecutiveRateLimits >= 12) throw error
        consecutiveRateLimits += 1
        const retryAfterMs = Math.min(10_000, 500 * (2 ** (consecutiveRateLimits - 1)))
        console.warn(JSON.stringify({
          component: "efp_indexer",
          operation: "backfill_rate_limited",
          batch,
          retry_after_ms: retryAfterMs,
        }))
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs))
        continue
      }
      console.info(JSON.stringify({
        component: "efp_indexer",
        operation: `backfill_${config.name}`,
        batch,
        ...summary,
      }))
      if (summary.status === "caught_up" || summary.throughBlock === summary.safeHeadBlock) {
        if (deferProjection) await finalizeDeferredProjection({ client, config: scanConfig })
        return
      }
      batch += 1
    }
    throw new Error(`EFP backfill stopped after ${batchLimit} batches before reaching safe head`)
  })
}

if (import.meta.main) {
  await main()
}
