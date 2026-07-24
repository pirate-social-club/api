import { isAddress, type Address, type Hex } from "viem"

import type { Client, QueryResultRow } from "../sql-client"
import { applyEfpListOp, decodeEfpListOp, isEffectiveEfpFollow } from "./list-op"
import { EFP_BASE_CHAIN_ID, EFP_BASE_LIST_RECORDS } from "./scanner"

export type DerivedEfpGraph = {
  indexedThroughBlock: string
  safeHeadBlock: string
  followingByAddress: Map<Address, Set<Address>>
  followerCountByAddress: Map<Address, number>
  primaryListIdByAddress: Map<Address, string>
}

function normalizedAddress(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value)
    ? value.toLowerCase() as Address
    : null
}

function decimalString(row: QueryResultRow | undefined, key: string): string | null {
  const value = row?.[key]
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value)
  if (typeof value === "string" && /^\d+$/u.test(value)) return value
  return null
}

export async function deriveIndexedEfpGraph(client: Client): Promise<DerivedEfpGraph> {
  const cursorResult = await client.execute({
    sql: `
      SELECT indexed_through_block, safe_head_block
      FROM efp_indexer_cursors
      WHERE chain_id = ?1
    `,
    args: [EFP_BASE_CHAIN_ID],
  })
  const indexedThroughBlock = decimalString(cursorResult.rows[0], "indexed_through_block")
  const safeHeadBlock = decimalString(cursorResult.rows[0], "safe_head_block")
  if (!indexedThroughBlock || !safeHeadBlock) {
    throw new Error("EFP Base index has no freshness cursor")
  }

  const result = await client.execute({
    sql: `
      WITH ranked_primary AS (
        SELECT
          account_address,
          list_id,
          ROW_NUMBER() OVER (
            PARTITION BY account_address
            ORDER BY block_number DESC, transaction_index DESC, log_index DESC
          ) AS row_number
        FROM efp_primary_list_events
      ),
      ranked_storage AS (
        SELECT
          list_id,
          storage_chain_id,
          storage_contract_address,
          storage_slot,
          ROW_NUMBER() OVER (
            PARTITION BY list_id
            ORDER BY block_number DESC, transaction_index DESC, log_index DESC
          ) AS row_number
        FROM efp_list_storage_location_events
      ),
      authoritative_base_lists AS (
        SELECT primary_lists.account_address, primary_lists.list_id, storage.storage_slot
        FROM ranked_primary primary_lists
        JOIN ranked_storage storage
          ON storage.list_id = primary_lists.list_id
         AND storage.row_number = 1
        WHERE primary_lists.row_number = 1
          AND primary_lists.list_id IS NOT NULL
          AND storage.storage_chain_id = ?1
          AND storage.storage_contract_address = ?2
          AND storage.storage_slot IS NOT NULL
      )
      SELECT
        lists.account_address,
        lists.list_id,
        ops.raw_op
      FROM authoritative_base_lists lists
      CROSS JOIN efp_list_ops ops
      WHERE ops.chain_id = ?1
        AND ops.contract_address = ?2
        AND ops.slot = lists.storage_slot
      ORDER BY
        lists.account_address,
        ops.block_number,
        ops.transaction_index,
        ops.log_index
    `,
    args: [EFP_BASE_CHAIN_ID, EFP_BASE_LIST_RECORDS],
  })

  const entriesByAddress = new Map<Address, Map<Address, {
    followed: boolean
    tags: Set<string>
  }>>()
  const primaryListIdByAddress = new Map<Address, string>()
  for (const row of result.rows) {
    const account = normalizedAddress(row.account_address)
    const listId = decimalString(row, "list_id")
    const rawOp = row.raw_op
    if (!account || !listId || typeof rawOp !== "string" || !/^0x[0-9a-f]+$/iu.test(rawOp)) continue
    primaryListIdByAddress.set(account, listId)
    const entries = entriesByAddress.get(account) ?? new Map()
    applyEfpListOp(entries, decodeEfpListOp(rawOp as Hex))
    entriesByAddress.set(account, entries)
  }

  const followingByAddress = new Map<Address, Set<Address>>()
  const followerCountByAddress = new Map<Address, number>()
  for (const [account, entries] of entriesByAddress) {
    const following = new Set<Address>()
    for (const [target, entry] of entries) {
      if (!isEffectiveEfpFollow(entry)) continue
      following.add(target)
      followerCountByAddress.set(target, (followerCountByAddress.get(target) ?? 0) + 1)
    }
    followingByAddress.set(account, following)
  }

  return {
    indexedThroughBlock,
    safeHeadBlock,
    followingByAddress,
    followerCountByAddress,
    primaryListIdByAddress,
  }
}

type HostedRelationshipResponse = {
  state?: {
    is_following?: unknown
  }
}

type HostedStatsResponse = {
  followers_count?: unknown
  following_count?: unknown
}

type HostedFollowingResponse = {
  following?: Array<{ address?: unknown; data?: unknown }>
}

function count(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value)
  return null
}

async function fetchHostedRelationship(
  apiUrl: string,
  viewer: Address,
  target: Address,
): Promise<boolean> {
  const response = await fetch(
    `${apiUrl}/api/v1/users/${viewer}/${target}/relationship`,
    { headers: { Accept: "application/json" } },
  )
  if (!response.ok) {
    throw new Error(`Hosted EFP relationship failed (${response.status}) for ${viewer} -> ${target}`)
  }
  const payload = await response.json() as HostedRelationshipResponse
  if (typeof payload.state?.is_following !== "boolean") {
    throw new Error(`Hosted EFP relationship is malformed for ${viewer} -> ${target}`)
  }
  return payload.state.is_following
}

async function fetchHostedStats(apiUrl: string, address: Address): Promise<{
  followerCount: number
  followingCount: number
}> {
  const response = await fetch(
    `${apiUrl}/api/v1/users/${address}/stats?live=true`,
    { headers: { Accept: "application/json" } },
  )
  if (!response.ok) throw new Error(`Hosted EFP stats failed (${response.status}) for ${address}`)
  const payload = await response.json() as HostedStatsResponse
  const followerCount = count(payload.followers_count)
  const followingCount = count(payload.following_count)
  if (followerCount == null || followingCount == null) {
    throw new Error(`Hosted EFP stats are malformed for ${address}`)
  }
  return { followerCount, followingCount }
}

async function fetchHostedListStats(apiUrl: string, listId: string): Promise<{
  followingCount: number
}> {
  const response = await fetch(`${apiUrl}/api/v1/lists/${listId}/stats`, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error(`Hosted EFP list stats failed (${response.status}) for ${listId}`)
  const payload = await response.json() as HostedStatsResponse
  const followingCount = count(payload.following_count)
  if (followingCount == null) throw new Error(`Hosted EFP list stats are malformed for ${listId}`)
  return { followingCount }
}

async function fetchHostedPositiveTarget(apiUrl: string, listId: string): Promise<Address | null> {
  const response = await fetch(`${apiUrl}/api/v1/lists/${listId}/following?limit=1`, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error(`Hosted EFP list following failed (${response.status}) for ${listId}`)
  const payload = await response.json() as HostedFollowingResponse
  const first = Array.isArray(payload.following) ? payload.following[0] : undefined
  return normalizedAddress(first?.address) ?? normalizedAddress(first?.data)
}

export type EfpComparisonMismatch = {
  address: Address
  indexedThroughBlock: string
  safeHeadBlock: string
  ourFollowerCountLowerBound: number | null
  hostedFollowerCount: number
  ourFollowingCount: number
  hostedFollowingCount: number
  relationshipMismatches: Array<{
    target: Address
    expected: boolean
    actual: boolean
  }>
  followerDirectionViolation: boolean
}

export async function compareIndexedEfpGraph(input: {
  client: Client
  addresses: readonly Address[]
  apiUrl?: string
}): Promise<{
  requested: number
  compared: number
  mismatches: EfpComparisonMismatch[]
  mismatchRate: number
  indexedThroughBlock: string
  safeHeadBlock: string
}> {
  const apiUrl = (input.apiUrl ?? "https://api.ethfollow.xyz").replace(/\/+$/u, "")
  const graph = await deriveIndexedEfpGraph(input.client)
  const mismatches: EfpComparisonMismatch[] = []
  let compared = 0

  for (const [index, address] of input.addresses.entries()) {
    const primaryListId = graph.primaryListIdByAddress.get(address)
    if (!primaryListId) continue
    compared += 1
    const negativeCandidates = input.addresses.filter((candidate) => candidate !== address)
    let negativeTarget: Address | null = null
    for (let offset = 0; offset < negativeCandidates.length; offset += 1) {
      const candidate = negativeCandidates[(index + offset) % negativeCandidates.length]
      if (candidate && !await fetchHostedRelationship(apiUrl, address, candidate)) {
        negativeTarget = candidate
        break
      }
    }
    const [positiveTarget, hostedListStats, hostedStats] = await Promise.all([
      fetchHostedPositiveTarget(apiUrl, primaryListId),
      fetchHostedListStats(apiUrl, primaryListId),
      fetchHostedStats(apiUrl, address),
    ])
    const ours = graph.followingByAddress.get(address) ?? new Set<Address>()
    const relationshipMismatches: EfpComparisonMismatch["relationshipMismatches"] = []
    if (positiveTarget && !ours.has(positiveTarget)) {
      relationshipMismatches.push({ target: positiveTarget, expected: true, actual: false })
    }
    if (negativeTarget && ours.has(negativeTarget)) {
      relationshipMismatches.push({ target: negativeTarget, expected: false, actual: true })
    }
    const ourFollowerCountLowerBound = graph.followerCountByAddress.get(address) ?? null
    const followerDirectionViolation = ourFollowerCountLowerBound != null
      && ourFollowerCountLowerBound > hostedStats.followerCount
    if (
      relationshipMismatches.length > 0
      || ours.size !== hostedListStats.followingCount
      || followerDirectionViolation
    ) {
      mismatches.push({
        address,
        indexedThroughBlock: graph.indexedThroughBlock,
        safeHeadBlock: graph.safeHeadBlock,
        ourFollowerCountLowerBound,
        hostedFollowerCount: hostedStats.followerCount,
        ourFollowingCount: ours.size,
        hostedFollowingCount: hostedListStats.followingCount,
        relationshipMismatches,
        followerDirectionViolation,
      })
    }
  }

  return {
    requested: input.addresses.length,
    compared,
    mismatches,
    mismatchRate: compared === 0 ? 0 : mismatches.length / compared,
    indexedThroughBlock: graph.indexedThroughBlock,
    safeHeadBlock: graph.safeHeadBlock,
  }
}
