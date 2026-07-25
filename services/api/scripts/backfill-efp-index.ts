#!/usr/bin/env bun

import type { Env } from "../src/env"
import {
  EFP_INDEXER_CHAINS,
  scanEfpChainOnce,
  type EfpIndexerChainConfig,
} from "../src/lib/efp-indexer/scanner"
import { getControlPlaneClient, withRequestControlPlaneClients } from "../src/lib/runtime-deps"

function positiveBatchLimit(value: string | undefined): number {
  if (value == null) return 10_000
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Optional batch limit must be a positive integer")
  }
  return parsed
}

function blockSpan(value: string | undefined): bigint | undefined {
  if (!value) return undefined
  if (!/^\d+$/u.test(value)) throw new Error("EFP_BACKFILL_BLOCK_SPAN must be a positive integer")
  const parsed = BigInt(value)
  if (parsed <= 0n || parsed > 1_000_000n) {
    throw new Error("EFP_BACKFILL_BLOCK_SPAN must be between 1 and 1000000")
  }
  return parsed
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

  await withRequestControlPlaneClients(async () => {
    const client = getControlPlaneClient(env)
    let consecutiveRateLimits = 0
    for (let batch = 1; batch <= batchLimit;) {
      let summary
      try {
        summary = await scanEfpChainOnce({ client, rpcUrl, config, blockSpan: requestedBlockSpan })
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
      if (summary.status === "caught_up" || summary.throughBlock === summary.safeHeadBlock) return
      batch += 1
    }
    throw new Error(`EFP backfill stopped after ${batchLimit} batches before reaching safe head`)
  })
}

if (import.meta.main) {
  await main()
}
