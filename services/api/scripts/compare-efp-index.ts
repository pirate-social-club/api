#!/usr/bin/env bun

import { readFile } from "node:fs/promises"
import { isAddress, type Address } from "viem"

import type { Env } from "../src/env"
import { compareIndexedEfpGraph } from "../src/lib/efp-indexer/comparison"
import { getControlPlaneClient, withRequestControlPlaneClients } from "../src/lib/runtime-deps"
import type { Client } from "../src/lib/sql-client"

type LeaderboardResponse = {
  results?: Array<{ address?: unknown }>
}

function normalizeAddresses(values: readonly unknown[], limit = 50): Address[] {
  return [...new Set(values.flatMap((value) => {
    if (typeof value !== "string" || !isAddress(value)) return []
    return [value.toLowerCase() as Address]
  }))].slice(0, limit)
}

type CohortBuckets = {
  pirate: unknown[]
  random: unknown[]
  whales: unknown[]
}

async function loadCohortFixture(path: string): Promise<CohortBuckets> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CohortBuckets>
  if (!Array.isArray(parsed.pirate) || !Array.isArray(parsed.random) || !Array.isArray(parsed.whales)) {
    throw new Error("Cohort fixture must contain pirate, random, and whales arrays")
  }
  return { pirate: parsed.pirate, random: parsed.random, whales: parsed.whales }
}

async function loadWhales(limit: number): Promise<Address[]> {
  const response = await fetch(`https://api.ethfollow.xyz/api/v1/leaderboard/ranked?limit=${limit}`, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error(`Unable to load EFP whale cohort (${response.status})`)
  const payload = await response.json() as LeaderboardResponse
  return normalizeAddresses((payload.results ?? []).map((row) => row.address), limit)
}

async function loadAddresses(path: string | undefined, client: Client): Promise<Address[]> {
  let buckets: CohortBuckets
  if (path) {
    buckets = await loadCohortFixture(path)
  } else {
    const [pirateRows, randomRows, whales] = await Promise.all([
      client.execute(`
        SELECT attachments.wallet_address_normalized AS address
        FROM users
        JOIN wallet_attachments attachments
          ON attachments.wallet_attachment_id = users.primary_wallet_attachment_id
        WHERE attachments.status = 'active'
          AND attachments.chain_namespace = 'eip155'
        ORDER BY users.created_at DESC
        LIMIT 50
      `),
      client.execute(`
        SELECT DISTINCT primary_lists.account_address AS address
        FROM efp_primary_list_events primary_lists
        JOIN efp_list_ops ops
          ON ops.target_address = primary_lists.account_address
        ORDER BY primary_lists.account_address
        LIMIT 100
      `),
      loadWhales(25),
    ])
    buckets = {
      pirate: pirateRows.rows.map((row) => row.address),
      random: randomRows.rows.map((row) => row.address),
      whales,
    }
  }

  const selected: Address[] = []
  for (const [name, values, size] of [
    ["pirate", buckets.pirate, 20],
    ["random", buckets.random, 20],
    ["whales", buckets.whales, 10],
  ] as const) {
    const unique = normalizeAddresses(values).filter((address) => !selected.includes(address)).slice(0, size)
    if (unique.length !== size) {
      throw new Error(`Comparison cohort requires ${size} unique ${name} addresses; received ${unique.length}`)
    }
    selected.push(...unique)
  }
  return selected
}

async function main(): Promise<void> {
  const env = process.env as unknown as Env
  if (!env.CONTROL_PLANE_DATABASE_URL) {
    throw new Error("CONTROL_PLANE_DATABASE_URL is required")
  }
  const result = await withRequestControlPlaneClients(async () => {
    const client = getControlPlaneClient(env)
    const addresses = await loadAddresses(process.argv[2], client)
    return await compareIndexedEfpGraph({ client, addresses })
  })
  for (const mismatch of result.mismatches) {
    console.error(JSON.stringify({
      component: "efp_indexer",
      operation: "shadow_compare_mismatch",
      ...mismatch,
    }))
  }
  const relationshipMismatchCount = result.mismatches.filter(
    (mismatch) => mismatch.relationshipMismatches.length > 0,
  ).reduce((total, mismatch) => total + mismatch.relationshipMismatches.length, 0)
  const followingCountMismatchCount = result.mismatches.filter(
    (mismatch) => mismatch.ourFollowingCount !== mismatch.hostedFollowingCount,
  ).length
  const followerCountMismatchCount = result.mismatches.filter(
    (mismatch) => mismatch.followerDirectionViolation,
  ).length
  console.info(JSON.stringify({
    component: "efp_indexer",
    operation: "shadow_compare_summary",
    requested: result.requested,
    compared: result.compared,
    mismatch_count: result.mismatches.length,
    mismatch_rate: result.mismatchRate,
    relationship_mismatch_count: relationshipMismatchCount,
    following_count_mismatch_count: followingCountMismatchCount,
    follower_direction_violation_count: followerCountMismatchCount,
    indexed_through_block: result.indexedThroughBlock,
    safe_head_block: result.safeHeadBlock,
  }))
  if (result.mismatches.length > 0) process.exitCode = 2
}

if (import.meta.main) {
  await main()
}
