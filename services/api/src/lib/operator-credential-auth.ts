import { createHash, timingSafeEqual } from "node:crypto"
import { authError, eligibilityFailed } from "./errors"
import { getControlPlaneClient } from "./runtime-deps"
import { requiredString, rowValue, stringOrNull } from "./sql-row"
import type { Env } from "../env"
import type { DbExecutor } from "./db-helpers"

export const BOOKING_SETTLEMENT_RESOLVE_SCOPE = "bookings:settlement:resolve"

const ALLOWED_OPERATOR_SCOPES = new Set<string>([
  BOOKING_SETTLEMENT_RESOLVE_SCOPE,
])
const DUMMY_SHA256_HEX = "0".repeat(64)
const LAST_USED_TOUCH_INTERVAL_MS = 5 * 60 * 1000

export type OperatorScope = typeof BOOKING_SETTLEMENT_RESOLVE_SCOPE

export type OperatorActorContext = {
  authType: "operator_credential"
  operatorCredentialId: string
  operatorActorId: string
  scopes: OperatorScope[]
}

type OperatorCredentialRow = {
  operator_credential_id: string
  operator_actor_id: string
  secret_hash: string
  secret_hash_algo: string
  secret_hash_version: number
  scopes_json: string
  status: string
  expires_at: string
  last_used_at: string | null
}

export function hashOperatorCredentialSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest()
  const rightDigest = createHash("sha256").update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

function parseOperatorAuthorization(headerValue: string | undefined): {
  operatorCredentialId: string
  secret: string
} {
  if (!headerValue?.startsWith("Operator ")) {
    throw authError("Authentication failed")
  }

  const token = headerValue.slice("Operator ".length).trim()
  const separator = token.indexOf(".")
  if (separator <= 0 || separator === token.length - 1) {
    throw authError("Authentication failed")
  }

  const operatorCredentialId = token.slice(0, separator).trim()
  const secret = token.slice(separator + 1).trim()
  if (!operatorCredentialId || !secret) {
    throw authError("Authentication failed")
  }

  return { operatorCredentialId, secret }
}

function parseOperatorScopes(scopesJson: string): OperatorScope[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(scopesJson)
  } catch {
    throw authError("Authentication failed")
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw authError("Authentication failed")
  }

  const scopes: OperatorScope[] = []
  const seen = new Set<string>()
  for (const scope of parsed) {
    if (typeof scope !== "string" || !ALLOWED_OPERATOR_SCOPES.has(scope) || seen.has(scope)) {
      throw authError("Authentication failed")
    }
    seen.add(scope)
    scopes.push(scope as OperatorScope)
  }

  return scopes
}

function parseIsoMs(value: string): number {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : NaN
}

function toOperatorCredentialRow(row: unknown): OperatorCredentialRow {
  return {
    operator_credential_id: requiredString(row, "operator_credential_id"),
    operator_actor_id: requiredString(row, "operator_actor_id"),
    secret_hash: requiredString(row, "secret_hash"),
    secret_hash_algo: requiredString(row, "secret_hash_algo"),
    secret_hash_version: Number(rowValue(row, "secret_hash_version")),
    scopes_json: requiredString(row, "scopes_json"),
    status: requiredString(row, "status"),
    expires_at: requiredString(row, "expires_at"),
    last_used_at: stringOrNull(rowValue(row, "last_used_at")),
  }
}

async function getOperatorCredentialRow(
  executor: DbExecutor,
  operatorCredentialId: string,
): Promise<OperatorCredentialRow | null> {
  const result = await executor.execute({
    sql: `
      SELECT operator_credential_id, operator_actor_id, secret_hash, secret_hash_algo,
             secret_hash_version, scopes_json, status, expires_at, last_used_at
      FROM operator_credentials
      WHERE operator_credential_id = ?1
      LIMIT 1
    `,
    args: [operatorCredentialId],
  })
  const row = result.rows[0]
  return row ? toOperatorCredentialRow(row) : null
}

async function touchOperatorCredentialLastUsed(input: {
  executor: DbExecutor
  operatorCredentialId: string
  nowIso: string
  thresholdIso: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE operator_credentials
      SET last_used_at = ?2
      WHERE operator_credential_id = ?1
        AND (last_used_at IS NULL OR last_used_at < ?3)
    `,
    args: [input.operatorCredentialId, input.nowIso, input.thresholdIso],
  })
}

export async function authenticateOperatorCredential(input: {
  env: Env
  authorization: string | undefined
  now?: () => number
  executor?: DbExecutor
}): Promise<OperatorActorContext> {
  const now = input.now ?? (() => Date.now())
  const { operatorCredentialId, secret } = parseOperatorAuthorization(input.authorization)
  const executor = input.executor ?? getControlPlaneClient(input.env)
  const row = await getOperatorCredentialRow(executor, operatorCredentialId)
  const computedHash = hashOperatorCredentialSecret(secret)
  const storedHash = row?.secret_hash ?? DUMMY_SHA256_HEX
  const hashMatches = timingSafeStringEqual(computedHash, storedHash)

  if (!row || !hashMatches) {
    throw authError("Authentication failed")
  }
  if (
    row.secret_hash_algo !== "sha256"
    || !Number.isInteger(row.secret_hash_version)
    || row.secret_hash_version < 1
  ) {
    throw authError("Authentication failed")
  }
  if (row.status !== "active") {
    throw authError("Authentication failed")
  }

  const nowMs = now()
  const expiresAtMs = parseIsoMs(row.expires_at)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw authError("Authentication failed")
  }

  const scopes = parseOperatorScopes(row.scopes_json)
  const nowIso = new Date(nowMs).toISOString()
  const thresholdIso = new Date(nowMs - LAST_USED_TOUCH_INTERVAL_MS).toISOString()
  await touchOperatorCredentialLastUsed({
    executor,
    operatorCredentialId: row.operator_credential_id,
    nowIso,
    thresholdIso,
  })

  return {
    authType: "operator_credential",
    operatorCredentialId: row.operator_credential_id,
    operatorActorId: row.operator_actor_id,
    scopes,
  }
}

export function requireOperatorScope(
  actor: OperatorActorContext | { authType: string },
  requiredScope: OperatorScope,
): asserts actor is OperatorActorContext {
  if (actor.authType !== "operator_credential") {
    throw eligibilityFailed("Operator credential is required", { required_scope: requiredScope })
  }
  if (!actor.scopes.includes(requiredScope)) {
    throw eligibilityFailed("Insufficient operator scope", { required_scope: requiredScope })
  }
}
