#!/usr/bin/env bun

import type { Env } from "../src/env"
import {
  EFP_INDEXER_CHAINS,
  scanEfpChainOnce,
  type EfpIndexerChainConfig,
} from "../src/lib/efp-indexer/scanner"
import { getControlPlaneClient, withRequestControlPlaneClients } from "../src/lib/runtime-deps"
import {
  findEfpFollowersAffectedByChain,
  rebuildEfpProjectionAfterRangeReplacement,
  refreshEfpProjectionAvailability,
} from "../src/lib/efp-indexer/materializer"
import { readEfpIndexerCursor } from "../src/lib/efp-indexer/repository"
import { withTransaction } from "../src/lib/transactions"

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

async function finalizeDeferredProjection(input: {
  client: ReturnType<typeof getControlPlaneClient>
  config: EfpIndexerChainConfig
}): Promise<void> {
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
  const now = new Date().toISOString()
  await withTransaction(input.client, "write", async (tx) => {
    const affectedAccounts = await findEfpFollowersAffectedByChain({
      tx,
      chainId: input.config.chainId,
    })
    await rebuildEfpProjectionAfterRangeReplacement({
      tx,
      affectedSlots: [],
      affectedAccounts,
      affectedListIds: [],
      chainId: input.config.chainId,
      appliedThroughBlock: cursor.indexedThroughBlock,
      appliedThroughBlockHash: cursor.indexedThroughBlockHash,
      now,
    })
  })
  await refreshEfpProjectionAvailability({ client: input.client, now })
  console.info(JSON.stringify({
    component: "efp_indexer",
    operation: `finalize_${input.config.name}_projection`,
    slot_count: slotCount,
    applied_through_block: cursor.indexedThroughBlock.toString(),
  }))
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
