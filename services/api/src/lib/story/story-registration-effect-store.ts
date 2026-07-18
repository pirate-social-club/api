import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"

type RegistrationKind = "original" | "derivative"
type EffectStatus = "executing" | "confirmed" | "failed_prebroadcast" | "reconciliation_required"

export type StoryRegistrationEffect = {
  operationId: string
  registrationKind: RegistrationKind
  chainId: number
  signerAddress: string
  creatorWalletAddress: string
  primaryContentHash: string
  callDataHash: string
  durableRequestJson: string | null
  status: EffectStatus
  providerTxRef: string | null
  errorCode: string | null
  resultJson: string | null
  attemptCount: number
}

const SELECT_COLUMNS = `
  operation_id, registration_kind, chain_id, signer_address, creator_wallet_address,
  primary_content_hash, call_data_hash, durable_request_json,
  status, provider_tx_ref, error_code, result_json, attempt_count
`

function effectKey(communityId: string, assetId: string): string {
  return `story_registration:${communityId}:${assetId}`
}

function toRow(row: unknown): StoryRegistrationEffect {
  return {
    operationId: requiredString(row, "operation_id"),
    registrationKind: requiredString(row, "registration_kind") as RegistrationKind,
    chainId: requiredNumber(row, "chain_id"),
    signerAddress: requiredString(row, "signer_address"),
    creatorWalletAddress: requiredString(row, "creator_wallet_address"),
    primaryContentHash: requiredString(row, "primary_content_hash"),
    callDataHash: requiredString(row, "call_data_hash"),
    durableRequestJson: stringOrNull(rowValue(row, "durable_request_json")),
    status: requiredString(row, "status") as EffectStatus,
    providerTxRef: stringOrNull(rowValue(row, "provider_tx_ref")),
    errorCode: stringOrNull(rowValue(row, "error_code")),
    resultJson: stringOrNull(rowValue(row, "result_json")),
    attemptCount: requiredNumber(row, "attempt_count"),
  }
}

async function loadEffect(client: DbExecutor, key: string): Promise<StoryRegistrationEffect> {
  const row = await executeFirst(client, {
    sql: `SELECT ${SELECT_COLUMNS} FROM story_registration_effects WHERE effect_key = ?1 LIMIT 1`,
    args: [key],
  })
  if (!row) throw new Error("story_registration_effect_missing_after_reservation")
  return toRow(row)
}

async function loadEffectOrNull(client: DbExecutor, key: string): Promise<StoryRegistrationEffect | null> {
  const row = await executeFirst(client, {
    sql: `SELECT ${SELECT_COLUMNS} FROM story_registration_effects WHERE effect_key = ?1 LIMIT 1`,
    args: [key],
  })
  return row ? toRow(row) : null
}

export async function getStoryRegistrationEffect(input: {
  client: DbExecutor
  communityId: string
  assetId: string
}): Promise<StoryRegistrationEffect | null> {
  const row = await executeFirst(input.client, {
    sql: `SELECT ${SELECT_COLUMNS} FROM story_registration_effects WHERE effect_key = ?1 LIMIT 1`,
    args: [effectKey(input.communityId, input.assetId)],
  })
  return row ? toRow(row) : null
}

export async function attestStoryRegistrationNotBroadcast(input: {
  client: DbExecutor
  communityId: string
  assetId: string
  expectedOperationId: string
  reason: string
  now: string
}): Promise<StoryRegistrationEffect> {
  await transitionStoryRegistrationNotBroadcast(input)
  return await loadEffect(input.client, effectKey(input.communityId, input.assetId))
}

export async function transitionStoryRegistrationNotBroadcast(input: {
  client: DbExecutor
  communityId: string
  assetId: string
  expectedOperationId: string
  reason: string
  now: string
}): Promise<void> {
  const reason = input.reason.trim().replace(/\s+/g, " ").slice(0, 180)
  if (reason.length < 10) throw new Error("story_registration_resolution_reason_required")
  const updated = await input.client.execute({
    sql: `
      UPDATE story_registration_effects
      SET status = 'failed_prebroadcast', provider_tx_ref = NULL,
          error_code = ?3, updated_at = ?4
      WHERE effect_key = ?1 AND operation_id = ?2
        AND status = 'reconciliation_required' AND provider_tx_ref IS NULL
    `,
    args: [
      effectKey(input.communityId, input.assetId), input.expectedOperationId,
      `ops_confirmed_no_broadcast:${reason}`, input.now,
    ],
  })
  if ((updated.rowsAffected ?? 0) === 0) {
    throw new Error("story_registration_resolution_conflict")
  }
}

export async function transitionReconciledStoryRegistrationToConfirmed(input: {
  client: DbExecutor
  communityId: string
  assetId: string
  expectedOperationId: string
  providerTxRef: string
  result: unknown
  now: string
}): Promise<void> {
  const updated = await input.client.execute({
    sql: `
      UPDATE story_registration_effects
      SET status = 'confirmed', result_json = ?3, provider_tx_ref = ?4,
          error_code = NULL, confirmed_at = ?5, updated_at = ?5
      WHERE effect_key = ?1 AND operation_id = ?2
        AND status = 'reconciliation_required'
        AND (provider_tx_ref IS NULL OR LOWER(provider_tx_ref) = LOWER(?4))
    `,
    args: [
      effectKey(input.communityId, input.assetId), input.expectedOperationId,
      JSON.stringify(input.result), input.providerTxRef, input.now,
    ],
  })
  if ((updated.rowsAffected ?? 0) === 0) {
    throw new Error("story_registration_resolution_conflict")
  }
}

export async function transitionRevertedStoryRegistrationToRetryable(input: {
  client: DbExecutor
  communityId: string
  assetId: string
  expectedOperationId: string
  providerTxRef: string
  reason: string
  now: string
}): Promise<void> {
  const reason = input.reason.trim().replace(/\s+/g, " ").slice(0, 180)
  if (reason.length < 10) throw new Error("story_registration_resolution_reason_required")
  const updated = await input.client.execute({
    sql: `
      UPDATE story_registration_effects
      SET status = 'failed_prebroadcast', error_code = ?4, updated_at = ?5
      WHERE effect_key = ?1 AND operation_id = ?2
        AND status = 'reconciliation_required'
        AND LOWER(provider_tx_ref) = LOWER(?3)
    `,
    args: [
      effectKey(input.communityId, input.assetId), input.expectedOperationId,
      input.providerTxRef, `ops_verified_reverted:${reason}`, input.now,
    ],
  })
  if ((updated.rowsAffected ?? 0) === 0) {
    throw new Error("story_registration_resolution_conflict")
  }
}

export async function reserveStoryRegistrationEffect<T>(input: {
  client: DbExecutor
  communityId: string
  assetId: string
  registrationKind: RegistrationKind
  chainId: number
  signerAddress: string
  creatorWalletAddress: string
  primaryContentHash: string
  callDataHash: string
  durableRequestJson: string | null
  now: string
}): Promise<
  | {
      kind: "execute"
      operationId: string
      registrationKind: RegistrationKind
      chainId: number
      signerAddress: string
      callDataHash: string
      durableRequestJson: string
    }
  | { kind: "confirmed"; result: T }
> {
  const key = effectKey(input.communityId, input.assetId)
  const operationId = `sro_${crypto.randomUUID()}`
  let existing = await loadEffectOrNull(input.client, key)
  if (!existing && !input.durableRequestJson) {
    throw new Error("story_registration_durable_request_required")
  }
  const inserted = await input.client.execute({
    sql: `
      INSERT OR IGNORE INTO story_registration_effects (
        story_registration_effect_id, community_id, asset_id, effect_key, operation_id,
        registration_kind, chain_id, signer_address, creator_wallet_address,
        primary_content_hash, call_data_hash, durable_request_json, status, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'executing', ?13, ?13)
    `,
    args: [
      makeId("sre"), input.communityId, input.assetId, key, operationId,
      input.registrationKind, input.chainId, input.signerAddress, input.creatorWalletAddress,
      input.primaryContentHash, input.callDataHash, input.durableRequestJson, input.now,
    ],
  })
  if ((inserted.rowsAffected ?? 0) > 0) {
    return {
      kind: "execute",
      operationId,
      registrationKind: input.registrationKind,
      chainId: input.chainId,
      signerAddress: input.signerAddress,
      callDataHash: input.callDataHash,
      durableRequestJson: input.durableRequestJson!,
    }
  }

  existing = await loadEffect(input.client, key)
  if (existing.status === "confirmed") {
    if (!existing.resultJson) throw new Error("story_registration_effect_confirmed_without_result")
    return { kind: "confirmed", result: JSON.parse(existing.resultJson) as T }
  }
  if (!existing.durableRequestJson) {
    throw new Error("story_registration_legacy_request_reconciliation_required")
  }
  if (existing.status === "failed_prebroadcast") {
    const claimed = await input.client.execute({
      sql: `
        UPDATE story_registration_effects
        SET status = 'executing', operation_id = ?2, provider_tx_ref = NULL, error_code = NULL,
            attempt_count = attempt_count + 1, updated_at = ?3
        WHERE effect_key = ?1 AND status = 'failed_prebroadcast' AND operation_id = ?4
      `,
      args: [key, operationId, input.now, existing.operationId],
    })
    if ((claimed.rowsAffected ?? 0) > 0) {
      return {
        kind: "execute",
        operationId,
        registrationKind: existing.registrationKind,
        chainId: existing.chainId,
        signerAddress: existing.signerAddress,
        callDataHash: existing.callDataHash,
        durableRequestJson: existing.durableRequestJson,
      }
    }
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
