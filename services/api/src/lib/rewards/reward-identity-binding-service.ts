import type {
  RewardIdentityBinding,
  RewardIdentityBindingDocument,
  RewardIdentityBindingResponse,
} from "@pirate/api-contracts"

import type { Env } from "../../env"
import { makeId } from "../helpers"
import type { Client, InStatement, QueryResult } from "../sql-client"
import { rowValue, stringOrNull } from "../sql-row"
import { codedConflictError } from "../errors"
import { resolveRewardIdentityProvider } from "../verification/unique-human-eligibility"
import { normalizeIdentityEvidenceValue, readActiveIdentityEvidence } from "../verification/provider-keyed-identity-evidence"
import { unixSeconds } from "../../serializers/time"

type Executor = { execute(statement: InStatement | string): Promise<QueryResult> }

type BoundDocument = RewardIdentityBindingDocument & { expiresAt: string | null }

const BINDING_EXISTS = "reward_identity_binding_exists"
const DOCUMENT_INELIGIBLE = "reward_identity_document_ineligible"
const PROVIDER_UNSUPPORTED = "reward_identity_provider_unsupported"

function isEvidenceCurrent(document: BoundDocument, now: string): boolean {
  if (document.expiresAt == null) return true
  const expiresAtMs = Date.parse(document.expiresAt)
  const nowMs = Date.parse(now)
  return Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && expiresAtMs > nowMs
}

async function listBoundDocuments(
  client: Executor,
  userId: string,
): Promise<BoundDocument[]> {
  const grouped = new Map<string, BoundDocument[]>()
  const evidence = await readActiveIdentityEvidence({ client, userId, capabilities: ["nationality"] })
  for (const item of evidence) {
    if (item.provider !== "self") continue
    const identityNullifierId = item.sourceIdentityNullifierId
    const nationalityValue = normalizeIdentityEvidenceValue(item)
    const nationality = typeof nationalityValue === "string" ? nationalityValue : null
    const verifiedAt = item.verifiedAt
    if (!identityNullifierId || !nationality || !verifiedAt) continue
    const entry: BoundDocument = {
      identity_nullifier_id: identityNullifierId,
      provider: "self",
      nationality,
      verified_at: unixSeconds(verifiedAt),
      expiresAt: item.expiresAt,
    }
    grouped.set(identityNullifierId, [...(grouped.get(identityNullifierId) ?? []), entry])
  }

  const documents: BoundDocument[] = []
  for (const entries of grouped.values()) {
    // Multiple accepted nationalities bound to one document are conflicting
    // evidence. Fail closed instead of choosing the newest account projection.
    if (new Set(entries.map((entry) => entry.nationality)).size !== 1) continue
    documents.push(entries[0]!)
  }
  return documents
}

async function findActiveBinding(
  client: Executor,
  userId: string,
  boundDocuments: BoundDocument[],
): Promise<RewardIdentityBinding | null> {
  const result = await client.execute({
    sql: `
      SELECT reward_identity_binding_id, identity_nullifier_id, selected_at
      FROM reward_identity_bindings
      WHERE user_id = ?1 AND status = 'active'
      LIMIT 1
    `,
    args: [userId],
  })
  const row = result.rows[0]
  const identityNullifierId = stringOrNull(rowValue(row, "identity_nullifier_id"))
  const document = boundDocuments.find((candidate) => candidate.identity_nullifier_id === identityNullifierId)
  const bindingId = stringOrNull(rowValue(row, "reward_identity_binding_id"))
  const selectedAt = stringOrNull(rowValue(row, "selected_at"))
  if (!document || !bindingId || !selectedAt) return null
  return {
    id: bindingId,
    identity_nullifier_id: document.identity_nullifier_id,
    provider: "self",
    nationality: document.nationality,
    status: "active",
    selected_at: unixSeconds(selectedAt),
  }
}

export async function getRewardIdentityBinding(input: {
  env: Env
  client: Executor
  userId: string
  now?: string
}): Promise<RewardIdentityBindingResponse> {
  const provider = resolveRewardIdentityProvider(input.env.REWARDS_IDENTITY_PROVIDER)
  if (provider !== "self") {
    return { capability: "unavailable", provider, active_binding: null, selectable_documents: [] }
  }
  const now = input.now ?? new Date().toISOString()
  const boundDocuments = await listBoundDocuments(input.client, input.userId)
  // Evidence expiry means the user must re-prove before selecting a document;
  // it does not revoke a document or invalidate a selection already made from
  // accepted, unrevoked evidence. Nullifier revocation still invalidates it.
  const selectableDocuments = boundDocuments.filter((document) => isEvidenceCurrent(document, now))
  const activeBinding = await findActiveBinding(input.client, input.userId, boundDocuments)
  return {
    capability: activeBinding ? "selected" : "selection_required",
    provider: "self",
    active_binding: activeBinding,
    selectable_documents: selectableDocuments.map(({ expiresAt: _expiresAt, ...document }) => document),
  }
}

export function isActiveRewardIdentityBindingUniqueConflict(error: unknown): boolean {
  let current: unknown = error
  while (current && typeof current === "object") {
    const record = current as Record<string, unknown>
    const code = typeof record.code === "string" ? record.code : ""
    const constraint = typeof record.constraint === "string" ? record.constraint : ""
    const message = typeof record.message === "string" ? record.message : ""
    const isUnique = code === "23505"
      || code === "SQLITE_CONSTRAINT_UNIQUE"
      || /unique constraint|duplicate key/iu.test(message)
    const isActiveBinding = constraint === "idx_reward_identity_bindings_user_active"
      || message.includes("idx_reward_identity_bindings_user_active")
      || message.includes("reward_identity_bindings.user_id")
    if (isUnique && isActiveBinding) return true
    current = record.cause
  }
  return false
}

export async function selectRewardIdentityBinding(input: {
  env: Env
  client: Client
  userId: string
  identityNullifierId: string
  now?: string
}): Promise<RewardIdentityBindingResponse> {
  if (resolveRewardIdentityProvider(input.env.REWARDS_IDENTITY_PROVIDER) !== "self") {
    throw codedConflictError(PROVIDER_UNSUPPORTED, "Reward document selection requires the Self identity provider")
  }
  const now = input.now ?? new Date().toISOString()

  // A retry of an already-applied selection is a true no-op even after the
  // evidence used to seed it expires. Expired evidence cannot create or change
  // a selection, but it does not invalidate the existing binding.
  const current = await getRewardIdentityBinding({ ...input, now })
  if (current.active_binding?.identity_nullifier_id === input.identityNullifierId) return current

  const documents = (await listBoundDocuments(input.client, input.userId))
    .filter((document) => isEvidenceCurrent(document, now))
  if (!documents.some((document) => document.identity_nullifier_id === input.identityNullifierId)) {
    throw codedConflictError(DOCUMENT_INELIGIBLE, "The selected identity document has no active bound nationality evidence")
  }

  const tx = await input.client.transaction("write")
  try {
    // POST is both initial selection and authenticated reselection. The old
    // binding and its replacement transition atomically, so the user is never
    // left with zero active bindings after a failed insert.
    await tx.execute({
      sql: `
        UPDATE reward_identity_bindings
        SET status = 'superseded', superseded_at = ?2, updated_at = ?2
        WHERE user_id = ?1 AND status = 'active'
      `,
      args: [input.userId, now],
    })
    await tx.execute({
        sql: `
          INSERT INTO reward_identity_bindings (
            reward_identity_binding_id, user_id, identity_nullifier_id, status,
            selected_at, superseded_at, created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'active', ?4, NULL, ?4, ?4)
        `,
        args: [makeId("rib"), input.userId, input.identityNullifierId, now],
      })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    if (isActiveRewardIdentityBindingUniqueConflict(error)) {
      throw codedConflictError(BINDING_EXISTS, "Reward identity selection changed concurrently; retry with the current state")
    }
    throw error
  } finally {
    tx.close()
  }
  return getRewardIdentityBinding({ ...input, now })
}

export async function supersedeRewardIdentityBindingsForNullifier(input: {
  client: Executor
  identityNullifierId: string
  now?: string
}): Promise<number> {
  const now = input.now ?? new Date().toISOString()
  const result = await input.client.execute({
    sql: `
      UPDATE reward_identity_bindings
      SET status = 'superseded', superseded_at = ?2, updated_at = ?2
      WHERE identity_nullifier_id = ?1 AND status = 'active'
    `,
    args: [input.identityNullifierId, now],
  })
  return result.rowsAffected ?? 0
}
