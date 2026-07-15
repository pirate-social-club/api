import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"

type RegistrationKind = "original" | "derivative"
type EffectStatus = "executing" | "confirmed" | "failed_prebroadcast" | "reconciliation_required"

type EffectRow = {
  operationId: string
  registrationKind: RegistrationKind
  creatorWalletAddress: string
  primaryContentHash: string
  status: EffectStatus
  resultJson: string | null
  attemptCount: number
}

const SELECT_COLUMNS = `
  operation_id, registration_kind, creator_wallet_address, primary_content_hash,
  status, result_json, attempt_count
`

function effectKey(communityId: string, assetId: string): string {
  return `story_registration:${communityId}:${assetId}`
}

function toRow(row: unknown): EffectRow {
  return {
    operationId: requiredString(row, "operation_id"),
    registrationKind: requiredString(row, "registration_kind") as RegistrationKind,
    creatorWalletAddress: requiredString(row, "creator_wallet_address"),
    primaryContentHash: requiredString(row, "primary_content_hash"),
    status: requiredString(row, "status") as EffectStatus,
    resultJson: stringOrNull(rowValue(row, "result_json")),
    attemptCount: requiredNumber(row, "attempt_count"),
  }
}

async function loadEffect(client: DbExecutor, key: string): Promise<EffectRow> {
  const row = await executeFirst(client, {
    sql: `SELECT ${SELECT_COLUMNS} FROM story_registration_effects WHERE effect_key = ?1 LIMIT 1`,
    args: [key],
  })
  if (!row) throw new Error("story_registration_effect_missing_after_reservation")
  return toRow(row)
}

function assertSameRequest(row: EffectRow, input: {
  registrationKind: RegistrationKind
  creatorWalletAddress: string
  primaryContentHash: string
}): void {
  if (
    row.registrationKind !== input.registrationKind
    || row.creatorWalletAddress.toLowerCase() !== input.creatorWalletAddress.toLowerCase()
    || row.primaryContentHash.toLowerCase() !== input.primaryContentHash.toLowerCase()
  ) {
    throw new Error("story_registration_effect_request_conflict")
  }
}

export async function reserveStoryRegistrationEffect<T>(input: {
  client: DbExecutor
  communityId: string
  assetId: string
  registrationKind: RegistrationKind
  creatorWalletAddress: string
  primaryContentHash: string
  now: string
}): Promise<{ kind: "execute"; operationId: string } | { kind: "confirmed"; result: T }> {
  const key = effectKey(input.communityId, input.assetId)
  const operationId = `sro_${crypto.randomUUID()}`
  const inserted = await input.client.execute({
    sql: `
      INSERT OR IGNORE INTO story_registration_effects (
        story_registration_effect_id, community_id, asset_id, effect_key, operation_id,
        registration_kind, creator_wallet_address, primary_content_hash, status,
        created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'executing', ?9, ?9)
    `,
    args: [
      makeId("sre"), input.communityId, input.assetId, key, operationId,
      input.registrationKind, input.creatorWalletAddress, input.primaryContentHash, input.now,
    ],
  })
  if ((inserted.rowsAffected ?? 0) > 0) return { kind: "execute", operationId }

  let existing = await loadEffect(input.client, key)
  assertSameRequest(existing, input)
  if (existing.status === "confirmed") {
    if (!existing.resultJson) throw new Error("story_registration_effect_confirmed_without_result")
    return { kind: "confirmed", result: JSON.parse(existing.resultJson) as T }
  }
  if (existing.status === "failed_prebroadcast") {
    const claimed = await input.client.execute({
      sql: `
        UPDATE story_registration_effects
        SET status = 'executing', operation_id = ?2, error_code = NULL,
            attempt_count = attempt_count + 1, updated_at = ?3
        WHERE effect_key = ?1 AND status = 'failed_prebroadcast' AND operation_id = ?4
      `,
      args: [key, operationId, input.now, existing.operationId],
    })
    if ((claimed.rowsAffected ?? 0) > 0) return { kind: "execute", operationId }
    existing = await loadEffect(input.client, key)
    if (existing.status === "confirmed" && existing.resultJson) {
      return { kind: "confirmed", result: JSON.parse(existing.resultJson) as T }
    }
  }
  throw new Error(`story_registration_reconciliation_required:${existing.status}`)
}

export async function confirmStoryRegistrationEffect(input: {
  client: DbExecutor
  communityId: string
  assetId: string
  operationId: string
  result: unknown
  providerTxRef?: string | null
  now: string
}): Promise<void> {
  const updated = await input.client.execute({
    sql: `
      UPDATE story_registration_effects
      SET status = 'confirmed', result_json = ?3, provider_tx_ref = ?4,
          error_code = NULL, confirmed_at = ?5, updated_at = ?5
      WHERE effect_key = ?1 AND operation_id = ?2 AND status = 'executing'
    `,
    args: [
      effectKey(input.communityId, input.assetId), input.operationId,
      JSON.stringify(input.result), input.providerTxRef ?? null, input.now,
    ],
  })
  if ((updated.rowsAffected ?? 0) === 0) throw new Error("story_registration_effect_confirmation_fenced")
}

export async function failStoryRegistrationEffect(input: {
  client: DbExecutor
  communityId: string
  assetId: string
  operationId: string
  reconciliationRequired: boolean
  providerTxRef?: string | null
  errorCode: string
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE story_registration_effects
      SET status = ?3, provider_tx_ref = COALESCE(?4, provider_tx_ref),
          error_code = ?5, updated_at = ?6
      WHERE effect_key = ?1 AND operation_id = ?2 AND status = 'executing'
    `,
    args: [
      effectKey(input.communityId, input.assetId), input.operationId,
      input.reconciliationRequired ? "reconciliation_required" : "failed_prebroadcast",
      input.providerTxRef ?? null, input.errorCode, input.now,
    ],
  })
}
