import { executeFirst, type DbExecutor } from "../../db-helpers"
import { conflictError, internalError } from "../../errors"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../../sql-row"

export type GenericAssetQuotaReservationStatus = "reserved" | "reconciled" | "released" | "failed"

export const GENERIC_ASSET_PER_USER_COMMUNITY_QUOTA_BYTES = 2 * 1024 * 1024 * 1024
export const GENERIC_ASSET_COMMUNITY_QUOTA_BYTES = 20 * 1024 * 1024 * 1024

export type GenericAssetQuotaReservation = {
  reservation_id: string
  community_id: string
  user_id: string
  asset_id: string | null
  content_blob_id: string | null
  reservation_key: string
  status: GenericAssetQuotaReservationStatus
  reserved_bytes: number
  actual_bytes: number | null
  plaintext_bytes: number
  ciphertext_bytes: number
  package_bytes: number
  policy_version: string
  failure_code: string | null
  created_at: string
  updated_at: string
  reconciled_at: string | null
}

function reservationFromRow(row: unknown): GenericAssetQuotaReservation {
  return {
    reservation_id: requiredString(row, "reservation_id"),
    community_id: requiredString(row, "community_id"),
    user_id: requiredString(row, "user_id"),
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    content_blob_id: stringOrNull(rowValue(row, "content_blob_id")),
    reservation_key: requiredString(row, "reservation_key"),
    status: requiredString(row, "status") as GenericAssetQuotaReservationStatus,
    reserved_bytes: Number(numberOrNull(rowValue(row, "reserved_bytes"))),
    actual_bytes: numberOrNull(rowValue(row, "actual_bytes")),
    plaintext_bytes: Number(numberOrNull(rowValue(row, "plaintext_bytes"))),
    ciphertext_bytes: Number(numberOrNull(rowValue(row, "ciphertext_bytes"))),
    package_bytes: Number(numberOrNull(rowValue(row, "package_bytes"))),
    policy_version: requiredString(row, "policy_version"),
    failure_code: stringOrNull(rowValue(row, "failure_code")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
    reconciled_at: stringOrNull(rowValue(row, "reconciled_at")),
  }
}

const RESERVATION_COLUMNS = `
  reservation_id, community_id, user_id, asset_id, content_blob_id,
  reservation_key, status, reserved_bytes, actual_bytes, plaintext_bytes,
  ciphertext_bytes, package_bytes, policy_version, failure_code,
  created_at, updated_at, reconciled_at
`

async function findReservation(input: {
  client: DbExecutor
  userId: string
  reservationKey: string
}): Promise<GenericAssetQuotaReservation | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT ${RESERVATION_COLUMNS}
      FROM generic_asset_quota_reservations
      WHERE user_id = ?1 AND reservation_key = ?2
      LIMIT 1
    `,
    args: [input.userId, input.reservationKey],
  })
  return row ? reservationFromRow(row) : null
}

function assertReservationRequest(input: {
  reservedBytes: number
  reservationKey: string
  maxAccountedBytes?: number | null
}): void {
  if (!Number.isSafeInteger(input.reservedBytes) || input.reservedBytes <= 0) {
    throw conflictError("Generic asset quota reservation must be a positive byte count")
  }
  if (!input.reservationKey.trim()) {
    throw conflictError("Generic asset quota reservation key is required")
  }
  if (
    input.maxAccountedBytes != null
    && (
      !Number.isSafeInteger(input.maxAccountedBytes)
      || input.maxAccountedBytes <= 0
      || input.maxAccountedBytes > GENERIC_ASSET_PER_USER_COMMUNITY_QUOTA_BYTES
    )
  ) {
    throw conflictError("Generic asset quota limit must be within the per-user community ceiling")
  }
}

function assertReservationMatches(input: {
  existing: GenericAssetQuotaReservation
  communityId: string
  assetId: string | null
  contentBlobId: string | null
  reservedBytes: number
  policyVersion: string
}): void {
  if (
    input.existing.community_id !== input.communityId
    || input.existing.asset_id !== input.assetId
    || input.existing.reserved_bytes !== input.reservedBytes
    || input.existing.content_blob_id !== input.contentBlobId
    || input.existing.policy_version !== input.policyVersion
  ) {
    throw conflictError("Generic asset quota reservation key was reused with different bytes")
  }
}

export async function reserveGenericAssetBytes(input: {
  client: DbExecutor
  reservationId: string
  communityId: string
  userId: string
  assetId?: string | null
  contentBlobId?: string | null
  reservationKey: string
  reservedBytes: number
  plaintextBytes?: number
  ciphertextBytes?: number
  packageBytes?: number
  policyVersion: string
  createdAt: string
  maxAccountedBytes?: number | null
}): Promise<GenericAssetQuotaReservation> {
  assertReservationRequest(input)
  const existing = await findReservation(input)
  if (existing) {
    assertReservationMatches({
      existing,
      communityId: input.communityId,
      assetId: input.assetId ?? null,
      contentBlobId: input.contentBlobId ?? null,
      reservedBytes: input.reservedBytes,
      policyVersion: input.policyVersion,
    })
    if (existing.status === "released" || existing.status === "failed") {
      const reopened = await input.client.execute({
        sql: `
          UPDATE generic_asset_quota_reservations
          SET status = 'reserved', actual_bytes = NULL,
              plaintext_bytes = ?1, ciphertext_bytes = ?2, package_bytes = ?3,
              failure_code = NULL, updated_at = ?4, reconciled_at = NULL
          WHERE reservation_id = ?5 AND status IN ('released', 'failed')
        `,
        args: [
          input.plaintextBytes ?? 0,
          input.ciphertextBytes ?? 0,
          input.packageBytes ?? 0,
          input.createdAt,
          existing.reservation_id,
        ],
      })
      if ((reopened.rowsAffected ?? 0) === 1) {
        const resumed = await findReservation(input)
        if (!resumed) throw internalError("Generic asset quota reservation is missing after resume")
        return resumed
      }
      const raced = await findReservation(input)
      if (raced) return raced
    }
    return existing
  }

  const inserted = await input.client.execute({
    sql: `
      INSERT INTO generic_asset_quota_reservations (
        reservation_id, community_id, user_id, asset_id, content_blob_id,
        reservation_key, status, reserved_bytes, plaintext_bytes,
        ciphertext_bytes, package_bytes, policy_version, created_at, updated_at
      )
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'reserved', ?7, ?8, ?9, ?10, ?11, ?12, ?12
      WHERE ?13 IS NULL OR (
        SELECT COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_bytes ELSE actual_bytes END), 0)
        FROM generic_asset_quota_reservations
        WHERE user_id = ?3 AND community_id = ?2
          AND status IN ('reserved', 'reconciled')
      ) + ?7 <= ?13
      AND (
        SELECT COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_bytes ELSE actual_bytes END), 0)
        FROM generic_asset_quota_reservations
        WHERE community_id = ?2
          AND status IN ('reserved', 'reconciled')
      ) + ?7 <= ?14
    `,
    args: [
      input.reservationId,
      input.communityId,
      input.userId,
      input.assetId ?? null,
      input.contentBlobId ?? null,
      input.reservationKey,
      input.reservedBytes,
      input.plaintextBytes ?? 0,
      input.ciphertextBytes ?? 0,
      input.packageBytes ?? 0,
      input.policyVersion,
      input.createdAt,
      input.maxAccountedBytes ?? GENERIC_ASSET_PER_USER_COMMUNITY_QUOTA_BYTES,
      GENERIC_ASSET_COMMUNITY_QUOTA_BYTES,
    ],
  })
  if ((inserted.rowsAffected ?? 0) !== 1) {
    const raced = await findReservation(input)
    if (raced) {
      if (raced.status === "released" || raced.status === "failed") {
        return reserveGenericAssetBytes(input)
      }
      return raced
    }
    throw conflictError("Generic asset byte quota is unavailable")
  }
  const created = await findReservation(input)
  if (!created) throw internalError("Generic asset quota reservation is missing after insert")
  return created
}

export async function reconcileGenericAssetBytes(input: {
  client: DbExecutor
  reservationId: string
  actualBytes: number
  plaintextBytes: number
  ciphertextBytes: number
  packageBytes: number
  reconciledAt: string
  maxAccountedBytes?: number | null
}): Promise<GenericAssetQuotaReservation> {
  if (
    !Number.isSafeInteger(input.actualBytes)
    || input.actualBytes < 0
    || !Number.isSafeInteger(input.plaintextBytes)
    || input.plaintextBytes < 0
    || !Number.isSafeInteger(input.ciphertextBytes)
    || input.ciphertextBytes < 0
    || !Number.isSafeInteger(input.packageBytes)
    || input.packageBytes < 0
    || input.actualBytes !== input.plaintextBytes + input.ciphertextBytes + input.packageBytes
  ) {
    throw conflictError("Generic asset reconciled bytes must be non-negative")
  }
  const maxAccountedBytes = input.maxAccountedBytes ?? GENERIC_ASSET_PER_USER_COMMUNITY_QUOTA_BYTES
  if (
    !Number.isSafeInteger(maxAccountedBytes)
    || maxAccountedBytes <= 0
    || maxAccountedBytes > GENERIC_ASSET_PER_USER_COMMUNITY_QUOTA_BYTES
  ) {
    throw conflictError("Generic asset quota limit must be within the per-user community ceiling")
  }
  const existing = await executeFirst(input.client, {
    sql: `SELECT ${RESERVATION_COLUMNS} FROM generic_asset_quota_reservations WHERE reservation_id = ?1 LIMIT 1`,
    args: [input.reservationId],
  })
  if (!existing) throw internalError("Generic asset quota reservation is missing")
  const existingReservation = reservationFromRow(existing)
  const result = await input.client.execute({
    sql: `
      UPDATE generic_asset_quota_reservations
      SET status = 'reconciled', actual_bytes = ?1,
          plaintext_bytes = ?2, ciphertext_bytes = ?3, package_bytes = ?4,
          reconciled_at = ?5, updated_at = ?5
      WHERE reservation_id = ?6 AND status = 'reserved'
        AND (
          SELECT COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_bytes ELSE actual_bytes END), 0)
          FROM generic_asset_quota_reservations
          WHERE user_id = ?7 AND community_id = ?8
            AND reservation_id <> ?6
            AND status IN ('reserved', 'reconciled')
        ) + ?1 <= ?9
        AND (
          SELECT COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_bytes ELSE actual_bytes END), 0)
          FROM generic_asset_quota_reservations
          WHERE community_id = ?8
            AND reservation_id <> ?6
            AND status IN ('reserved', 'reconciled')
        ) + ?1 <= ?10
    `,
    args: [
      input.actualBytes,
      input.plaintextBytes,
      input.ciphertextBytes,
      input.packageBytes,
      input.reconciledAt,
      input.reservationId,
      existingReservation.user_id,
      existingReservation.community_id,
      maxAccountedBytes,
      GENERIC_ASSET_COMMUNITY_QUOTA_BYTES,
    ],
  })
  const row = await executeFirst(input.client, {
    sql: `SELECT ${RESERVATION_COLUMNS} FROM generic_asset_quota_reservations WHERE reservation_id = ?1 LIMIT 1`,
    args: [input.reservationId],
  })
  if (!row) throw internalError("Generic asset quota reservation is missing")
  const reservation = reservationFromRow(row)
  if ((result.rowsAffected ?? 0) === 0 && reservation.status !== "reconciled") {
    if (reservation.status === "reserved") {
      throw conflictError("Generic asset byte quota would be exceeded")
    }
    throw conflictError("Generic asset quota reservation is not open")
  }
  return reservation
}

export async function releaseGenericAssetBytes(input: {
  client: DbExecutor
  reservationId: string
  releasedAt: string
  failureCode: string
}): Promise<GenericAssetQuotaReservation> {
  if (!input.failureCode.trim()) {
    throw conflictError("Generic asset quota release requires a failure code")
  }
  await input.client.execute({
    sql: `
      UPDATE generic_asset_quota_reservations
      SET status = 'released', failure_code = ?1, updated_at = ?2
      WHERE reservation_id = ?3 AND status = 'reserved'
    `,
    args: [input.failureCode, input.releasedAt, input.reservationId],
  })
  const row = await executeFirst(input.client, {
    sql: `SELECT ${RESERVATION_COLUMNS} FROM generic_asset_quota_reservations WHERE reservation_id = ?1 LIMIT 1`,
    args: [input.reservationId],
  })
  if (!row) throw internalError("Generic asset quota reservation is missing")
  return reservationFromRow(row)
}
