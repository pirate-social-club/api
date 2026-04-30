import { getControlPlaneClient } from "../runtime-deps"
import { getUserRow, listActiveWalletAttachmentRows } from "../auth/auth-db-user-queries"
import { parseVerificationCapabilities } from "../auth/auth-serializers"
import { badRequestError, internalError, notFoundError, rateLimited } from "../errors"
import { getPassportProvider } from "./passport-provider"
import type { Env, JoinEligibility, VerificationCapabilities } from "../../types"

const PASSPORT_REFRESH_RATE_LIMIT_MS = 60_000

type WalletScoreCapability = VerificationCapabilities["wallet_score"]
type WalletScoreStatus = NonNullable<JoinEligibility["wallet_score_status"]>

const lastRefreshByUserId = new Map<string, number>()

export function resetPassportWalletScoreRefreshLimitsForTests(): void {
  lastRefreshByUserId.clear()
}

function buildWalletScoreStatus(walletScore: WalletScoreCapability): WalletScoreStatus {
  // Without community context this field reflects the Passport scorer threshold.
  // Community gate minimums replace it through getJoinEligibility when community_id is supplied.
  return {
    current_score_decimal: walletScore.score_decimal ?? null,
    required_score_decimal: walletScore.score_threshold_decimal ?? null,
    passing_score: typeof walletScore.passing_score === "boolean" ? walletScore.passing_score : null,
    last_scored_at: walletScore.last_scored_at ?? null,
  }
}

function assertRefreshAllowed(userId: string, nowMs: number): void {
  const lastRefreshMs = lastRefreshByUserId.get(userId) ?? 0
  const retryAfterMs = PASSPORT_REFRESH_RATE_LIMIT_MS - (nowMs - lastRefreshMs)
  if (retryAfterMs > 0) {
    throw rateLimited("Passport score refresh is rate limited", {
      retry_after_seconds: Math.ceil(retryAfterMs / 1000),
    })
  }
  lastRefreshByUserId.set(userId, nowMs)
}

export async function refreshPassportWalletScore(input: {
  env: Env
  userId: string
  walletAttachmentId?: string | null
  now?: Date
}): Promise<{
  walletScore: WalletScoreCapability
  walletScoreStatus: WalletScoreStatus
}> {
  const now = input.now ?? new Date()
  const client = getControlPlaneClient(input.env)
  const userRow = await getUserRow(client, input.userId)
  if (!userRow) {
    throw notFoundError("User not found")
  }

  const walletRows = await listActiveWalletAttachmentRows(client, input.userId)
  if (walletRows.length === 0) {
    throw badRequestError("Attach a wallet before refreshing Passport score")
  }

  const walletAttachmentId = input.walletAttachmentId?.trim() || null
  const walletRow = walletAttachmentId
    ? walletRows.find((row) => row.wallet_attachment_id === walletAttachmentId) ?? null
    : walletRows.find((row) => row.wallet_attachment_id === userRow.primary_wallet_attachment_id)
      ?? walletRows.find((row) => row.is_primary === 1)
      ?? walletRows[0]
      ?? null
  if (!walletRow) {
    throw badRequestError("Wallet attachment does not belong to the authenticated user")
  }

  assertRefreshAllowed(input.userId, now.getTime())

  const walletScore = await getPassportProvider(input.env).refreshWalletScore({
    address: walletRow.wallet_address_display || walletRow.wallet_address_normalized,
    now,
  })
  const currentCapabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  const nextCapabilities: VerificationCapabilities = {
    ...currentCapabilities,
    wallet_score: walletScore,
  }

  const updated = await client.execute({
    sql: `
      UPDATE users
      SET verification_capabilities_json = ?2,
          updated_at = ?3
      WHERE user_id = ?1
    `,
    args: [input.userId, JSON.stringify(nextCapabilities), now.toISOString()],
  })
  if (updated.rowsAffected === 0) {
    throw internalError("Failed to update Passport wallet score")
  }

  return {
    walletScore,
    walletScoreStatus: buildWalletScoreStatus(walletScore),
  }
}
