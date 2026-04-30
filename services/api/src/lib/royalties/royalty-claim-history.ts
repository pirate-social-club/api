import type {
  RoyaltyClaimHistoryResponse,
  RoyaltyClaimRecord,
  RoyaltyClaimRecordRequest,
} from "@pirate/api-contracts"
import { createPublicClient, http, type Hash } from "viem"
import type { Env } from "../../env"
import { executeFirst, type DbExecutor } from "../db-helpers"
import { badRequestError, conflictError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { resolveStoryRpcUrl } from "../story/story-runtime-config"
import { nullableUnixSeconds, unixSeconds } from "../../serializers/time"

const HEX_32_BYTE_PATTERN = /^0x[a-fA-F0-9]{64}$/
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

type RoyaltyClaimStatus = RoyaltyClaimRecord["status"]

const ROYALTY_CLAIM_COLUMNS = `
  claim_id, user_id, tx_hash, wallet_address, chain_id, claimable_wip_wei_at_submission,
  ip_ids_json, auto_unwrap_ip_tokens, status, verified_at, verification_error, claimed_at, created_at
`

function parseIpIds(rawIpIds: unknown): string[] {
  if (!Array.isArray(rawIpIds)) {
    throw badRequestError("ip_ids must be an array")
  }
  const seen = new Set<string>()
  const ipIds: string[] = []
  for (const rawIpId of rawIpIds) {
    if (typeof rawIpId !== "string" || !EVM_ADDRESS_PATTERN.test(rawIpId)) {
      throw badRequestError("ip_ids must contain valid EVM addresses")
    }
    const ipId = rawIpId.toLowerCase()
    if (!seen.has(ipId)) {
      seen.add(ipId)
      ipIds.push(ipId)
    }
  }
  return ipIds
}

function assertRoyaltyClaimRecordRequest(input: RoyaltyClaimRecordRequest): RoyaltyClaimRecordRequest {
  if (!input || typeof input !== "object") {
    throw badRequestError("Invalid royalty claim payload")
  }
  if (typeof input.tx_hash !== "string" || !HEX_32_BYTE_PATTERN.test(input.tx_hash)) {
    throw badRequestError("tx_hash must be a 32-byte hex transaction hash")
  }
  if (typeof input.wallet_address !== "string" || !EVM_ADDRESS_PATTERN.test(input.wallet_address)) {
    throw badRequestError("wallet_address must be a valid EVM address")
  }
  if (!Number.isInteger(input.chain) || input.chain <= 0) {
    throw badRequestError("chain must be a positive integer")
  }
  if (typeof input.claimable_wip_wei_at_submission !== "string" || !/^\d+$/u.test(input.claimable_wip_wei_at_submission)) {
    throw badRequestError("claimable_wip_wei_at_submission must be a wei string")
  }
  if (typeof input.auto_unwrap_ip_tokens !== "boolean") {
    throw badRequestError("auto_unwrap_ip_tokens must be boolean")
  }

  return {
    tx_hash: input.tx_hash.toLowerCase(),
    wallet_address: input.wallet_address.toLowerCase(),
    chain: input.chain,
    claimable_wip_wei_at_submission: input.claimable_wip_wei_at_submission,
    ip_ids: parseIpIds(input.ip_ids),
    auto_unwrap_ip_tokens: input.auto_unwrap_ip_tokens,
  }
}

function rowToRoyaltyClaimRecord(row: Record<string, unknown>): RoyaltyClaimRecord {
  const autoUnwrap = row.auto_unwrap_ip_tokens
  return {
    id: `rcr_${String(row.claim_id)}`,
    object: "royalty_claim_record",
    user: `usr_${String(row.user_id)}`,
    tx_hash: String(row.tx_hash),
    wallet_address: String(row.wallet_address),
    chain: Number(row.chain_id),
    claimable_wip_wei_at_submission: String(row.claimable_wip_wei_at_submission),
    ip_ids: row.ip_ids_json ? JSON.parse(String(row.ip_ids_json)) as string[] : [],
    auto_unwrap_ip_tokens: autoUnwrap === true || autoUnwrap === 1 || autoUnwrap === "1",
    status: String(row.status ?? "pending") as RoyaltyClaimStatus,
    verified_at: nullableUnixSeconds(row.verified_at ? String(row.verified_at) : null),
    verification_error: row.verification_error ? String(row.verification_error) : null,
    claimed_at: unixSeconds(String(row.claimed_at)),
    created: unixSeconds(String(row.created_at)),
  }
}

export async function recordRoyaltyClaim(input: {
  env: Env
  userId: string
  body: RoyaltyClaimRecordRequest
}): Promise<RoyaltyClaimRecord> {
  const body = assertRoyaltyClaimRecordRequest(input.body)
  const client = getControlPlaneClient(input.env)
  try {
    const existing = await executeFirst(client, {
      sql: `
        SELECT ${ROYALTY_CLAIM_COLUMNS}
        FROM royalty_claim_events
        WHERE tx_hash = ?1
        LIMIT 1
      `,
      args: [body.tx_hash],
    }) as Record<string, unknown> | null
    if (existing) {
      if (String(existing.user_id) !== input.userId) {
        throw conflictError("Claim transaction already recorded")
      }
      return rowToRoyaltyClaimRecord(existing)
    }

    const now = nowIso()
    const claimId = makeId("rcl")
    await client.execute({
      sql: `
        INSERT INTO royalty_claim_events (
          claim_id,
          user_id,
          tx_hash,
          wallet_address,
          chain_id,
          claimable_wip_wei_at_submission,
          ip_ids_json,
          auto_unwrap_ip_tokens,
          status,
          verified_at,
          verification_error,
          claimed_at,
          created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', NULL, NULL, ?9, ?9)
      `,
      args: [
        claimId,
        input.userId,
        body.tx_hash,
        body.wallet_address,
        body.chain,
        body.claimable_wip_wei_at_submission,
        JSON.stringify(body.ip_ids),
        body.auto_unwrap_ip_tokens ? 1 : 0,
        now,
      ],
    })

    return {
      id: `rcr_${claimId}`,
      object: "royalty_claim_record",
      user: `usr_${input.userId}`,
      tx_hash: body.tx_hash,
      wallet_address: body.wallet_address,
      chain: body.chain,
      claimable_wip_wei_at_submission: body.claimable_wip_wei_at_submission,
      ip_ids: body.ip_ids,
      auto_unwrap_ip_tokens: body.auto_unwrap_ip_tokens,
      status: "pending",
      verified_at: null,
      verification_error: null,
      claimed_at: unixSeconds(now),
      created: unixSeconds(now),
    }
  } finally {
    client.close?.()
  }
}

async function updateRoyaltyClaimVerification(input: {
  executor: DbExecutor
  claimId: string
  status: Exclude<RoyaltyClaimStatus, "pending">
  verifiedAt: string
  verificationError?: string | null
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE royalty_claim_events
      SET status = ?2,
          verified_at = ?3,
          verification_error = ?4
      WHERE claim_id = ?1
    `,
    args: [input.claimId, input.status, input.verifiedAt, input.verificationError ?? null],
  })
}

function isReceiptNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.toLowerCase().includes("not found") || message.toLowerCase().includes("could not find")
}

export async function reconcileRoyaltyClaimEvents(input: {
  env: Env
  limit?: number
  getReceiptStatus?: (txHash: string) => Promise<"success" | "reverted" | "not_found">
}): Promise<{ checked: number; confirmed: number; failed: number; pending: number }> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 25))
  const client = getControlPlaneClient(input.env)
  try {
    const result = await client.execute({
      sql: `
        SELECT claim_id, tx_hash
        FROM royalty_claim_events
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT ?1
      `,
      args: [limit],
    })

    if (result.rows.length === 0) {
      return { checked: 0, confirmed: 0, failed: 0, pending: 0 }
    }

    const publicClient = input.getReceiptStatus
      ? null
      : createPublicClient({ transport: http(resolveStoryRpcUrl(input.env)) })
    let confirmed = 0
    let failed = 0
    let pending = 0

    for (const row of result.rows) {
      const claimId = String(row.claim_id)
      const txHash = String(row.tx_hash)
      let receiptStatus: "success" | "reverted" | "not_found"
      try {
        receiptStatus = input.getReceiptStatus
          ? await input.getReceiptStatus(txHash)
          : (await publicClient!.getTransactionReceipt({ hash: txHash as Hash })).status
      } catch (error) {
        if (isReceiptNotFoundError(error)) {
          pending += 1
          continue
        }
        await updateRoyaltyClaimVerification({
          executor: client,
          claimId,
          status: "failed",
          verifiedAt: nowIso(),
          verificationError: error instanceof Error ? error.message : String(error),
        })
        failed += 1
        continue
      }

      if (receiptStatus === "not_found") {
        pending += 1
        continue
      }

      await updateRoyaltyClaimVerification({
        executor: client,
        claimId,
        status: receiptStatus === "success" ? "confirmed" : "failed",
        verifiedAt: nowIso(),
        verificationError: receiptStatus === "success" ? null : "Transaction reverted",
      })
      if (receiptStatus === "success") {
        confirmed += 1
      } else {
        failed += 1
      }
    }

    return { checked: result.rows.length, confirmed, failed, pending }
  } finally {
    client.close?.()
  }
}

export async function listRoyaltyClaims(input: {
  env: Env
  userId: string
  limit?: number
}): Promise<RoyaltyClaimHistoryResponse> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 25))
  const client = getControlPlaneClient(input.env)
  try {
    const result = await client.execute({
      sql: `
        SELECT ${ROYALTY_CLAIM_COLUMNS}
        FROM royalty_claim_events
        WHERE user_id = ?1
        ORDER BY claimed_at DESC
        LIMIT ?2
      `,
      args: [input.userId, limit],
    })

    return {
      items: result.rows.map((row) => rowToRoyaltyClaimRecord(row as Record<string, unknown>)),
    }
  } finally {
    client.close?.()
  }
}
