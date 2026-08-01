import type {
  RewardIdentityBinding,
  RewardIdentityBindingDocument,
  RewardIdentityBindingResponse,
} from "@pirate/api-contracts"

import type { Env } from "../../env"
import { makeId } from "../helpers"
import type { InStatement, QueryResult } from "../sql-client"
import { rowValue, stringOrNull } from "../sql-row"
import { codedConflictError } from "../errors"
import { resolveRewardIdentityProvider } from "../verification/unique-human-eligibility"
import { unixSeconds } from "../../serializers/time"

type Executor = { execute(statement: InStatement | string): Promise<QueryResult> }

type BoundDocument = RewardIdentityBindingDocument & { expiresAt: string | null }

const BINDING_EXISTS = "reward_identity_binding_exists"
const DOCUMENT_INELIGIBLE = "reward_identity_document_ineligible"
const PROVIDER_UNSUPPORTED = "reward_identity_provider_unsupported"

function parseNationality(value: unknown): string | null {
  let parsed = value
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== "object") return null
  const nationality = String((parsed as Record<string, unknown>).nationality ?? "").trim().toUpperCase()
  return /^[A-Z]{3}$/.test(nationality) ? nationality : null
}

async function listSelectableDocuments(
  client: Executor,
  userId: string,
  now: string,
): Promise<BoundDocument[]> {
  const result = await client.execute({
    sql: `
      SELECT n.identity_nullifier_id, a.value_json, a.verified_at, a.expires_at
      FROM identity_nullifiers n
      JOIN user_attestations a
        ON a.source_identity_nullifier_id = n.identity_nullifier_id
       AND a.user_id = n.user_id
       AND a.provider = n.provider
       AND a.capability_key = 'nationality'
       AND a.status = 'accepted'
       AND a.revoked_at IS NULL
       AND (a.expires_at IS NULL OR a.expires_at > ?2)
      WHERE n.user_id = ?1
        AND n.provider = 'self'
        AND n.status = 'active'
      ORDER BY n.first_seen_at ASC, n.identity_nullifier_id ASC, a.verified_at DESC
    `,
    args: [userId, now],
  })

  const grouped = new Map<string, BoundDocument[]>()
  for (const row of result.rows) {
    const identityNullifierId = stringOrNull(rowValue(row, "identity_nullifier_id"))
    const nationality = parseNationality(rowValue(row, "value_json"))
    const verifiedAt = stringOrNull(rowValue(row, "verified_at"))
    if (!identityNullifierId || !nationality || !verifiedAt) continue
    const entry: BoundDocument = {
      identity_nullifier_id: identityNullifierId,
      provider: "self",
      nationality,
      verified_at: unixSeconds(verifiedAt),
      expiresAt: stringOrNull(rowValue(row, "expires_at")),
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
  selectableDocuments: BoundDocument[],
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
  const document = selectableDocuments.find((candidate) => candidate.identity_nullifier_id === identityNullifierId)
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
  const documents = await listSelectableDocuments(input.client, input.userId, input.now ?? new Date().toISOString())
  const activeBinding = await findActiveBinding(input.client, input.userId, documents)
  return {
    capability: activeBinding ? "selected" : "selection_required",
    provider: "self",
    active_binding: activeBinding,
    selectable_documents: documents.map(({ expiresAt: _expiresAt, ...document }) => document),
  }
}

function isActiveBindingConflict(error: unknown): boolean {
  const value = error as { code?: unknown; constraint?: unknown; message?: unknown }
  const material = `${String(value.code ?? "")} ${String(value.constraint ?? "")} ${String(value.message ?? "")}`.toLowerCase()
  return material.includes("idx_reward_identity_bindings_user_active")
    || (material.includes("unique") && material.includes("reward_identity_bindings.user_id"))
}

export async function selectRewardIdentityBinding(input: {
  env: Env
  client: Executor
  userId: string
  identityNullifierId: string
  now?: string
}): Promise<RewardIdentityBindingResponse> {
  if (resolveRewardIdentityProvider(input.env.REWARDS_IDENTITY_PROVIDER) !== "self") {
    throw codedConflictError(PROVIDER_UNSUPPORTED, "Reward document selection requires the Self identity provider")
  }
  const now = input.now ?? new Date().toISOString()
  const documents = await listSelectableDocuments(input.client, input.userId, now)
  if (!documents.some((document) => document.identity_nullifier_id === input.identityNullifierId)) {
    throw codedConflictError(DOCUMENT_INELIGIBLE, "The selected identity document has no active bound nationality evidence")
  }

  try {
    await input.client.execute({
      sql: `
        INSERT INTO reward_identity_bindings (
          reward_identity_binding_id, user_id, identity_nullifier_id, status,
          selected_at, superseded_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'active', ?4, NULL, ?4, ?4)
      `,
      args: [makeId("rib"), input.userId, input.identityNullifierId, now],
    })
  } catch (error) {
    if (isActiveBindingConflict(error)) {
      throw codedConflictError(BINDING_EXISTS, "An active reward identity document is already selected")
    }
    throw error
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
