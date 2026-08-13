import { conflictError, eligibilityFailed } from "../errors"
import type { Client, InStatement } from "../sql-client"

const ACTIVE_IDENTITY_NULLIFIER_INDEX = "idx_identity_nullifiers_active_unique"

export type ActiveIdentityNullifier = {
  identityNullifierId: string
  userId: string
}

export type IdentityNullifierInput = {
  provider: "self" | "very" | "zkpassport"
  mechanism: "zk-nullifier" | "palm-nullifier" | "zkpassport-unique-identifier"
  nullifierHash: string
}

export class VerificationSessionClaimLostError extends Error {
  constructor() {
    super("Verification session was finalized concurrently")
    this.name = "VerificationSessionClaimLostError"
  }
}

export class VerificationAttestationConflictError extends Error {
  constructor(cause: unknown) {
    super("Verification attestation was finalized concurrently", { cause })
    this.name = "VerificationAttestationConflictError"
  }
}

function isUserAttestationUniqueConflict(error: unknown): boolean {
  let current: unknown = error
  while (current && typeof current === "object") {
    const record = current as Record<string, unknown>
    const code = typeof record.code === "string" ? record.code : ""
    const constraint = typeof record.constraint === "string" ? record.constraint : ""
    const message = typeof record.message === "string" ? record.message : ""
    const isUnique = code === "23505"
      || code === "SQLITE_CONSTRAINT_UNIQUE"
      || /unique constraint|duplicate key/iu.test(message)
    if (
      isUnique
      && (
        constraint.startsWith("idx_user_attestations_accepted_")
        || message.includes("user_attestations")
      )
    ) return true
    current = record.cause
  }
  return false
}

export function isActiveIdentityNullifierUniqueConflict(error: unknown): boolean {
  let current: unknown = error
  while (current && typeof current === "object") {
    const record = current as Record<string, unknown>
    const code = typeof record.code === "string" ? record.code : ""
    const constraint = typeof record.constraint === "string" ? record.constraint : ""
    const message = typeof record.message === "string" ? record.message : ""
    const isUnique = code === "23505"
      || code === "SQLITE_CONSTRAINT_UNIQUE"
      || /unique constraint|duplicate key/iu.test(message)
    const isActiveNullifier = constraint === ACTIVE_IDENTITY_NULLIFIER_INDEX
      || message.includes(ACTIVE_IDENTITY_NULLIFIER_INDEX)
      || (
        message.includes("identity_nullifiers.provider")
        && message.includes("identity_nullifiers.mechanism")
        && message.includes("identity_nullifiers.nullifier_hash")
      )
    if (isUnique && isActiveNullifier) return true
    current = record.cause
  }
  return false
}

async function getActiveIdentityNullifier(
  client: Client,
  identityNullifier: IdentityNullifierInput,
): Promise<ActiveIdentityNullifier | null> {
  const result = await client.execute({
    sql: `
      SELECT identity_nullifier_id, user_id
      FROM identity_nullifiers
      WHERE provider = ?1
        AND mechanism = ?2
        AND nullifier_hash = ?3
        AND status = 'active'
      LIMIT 1
    `,
    args: [identityNullifier.provider, identityNullifier.mechanism, identityNullifier.nullifierHash],
  })
  const row = result.rows[0]
  return typeof row?.identity_nullifier_id === "string" && typeof row.user_id === "string"
    ? { identityNullifierId: row.identity_nullifier_id, userId: row.user_id }
    : null
}

export async function writeVerificationBatchWithNullifierRetry(input: {
  client: Client
  userId: string
  identityNullifier: IdentityNullifierInput
  activeNullifier: ActiveIdentityNullifier | null
  buildBatchStatements: (activeNullifier: ActiveIdentityNullifier | null) => InStatement[]
  activeNullifierRefreshStatementIndex?: number
  sessionClaimStatementIndex?: number
}): Promise<void> {
  const writeBatch = async (activeNullifier: ActiveIdentityNullifier | null): Promise<void> => {
    const statements = input.buildBatchStatements(activeNullifier)
    if (
      input.activeNullifierRefreshStatementIndex === undefined
      && input.sessionClaimStatementIndex === undefined
    ) {
      await input.client.batch(statements, "write")
      return
    }

    const transaction = await input.client.transaction("write")
    try {
      const results = await transaction.batch(statements, "write")
      if (
        input.sessionClaimStatementIndex !== undefined
        && results[input.sessionClaimStatementIndex]?.rowsAffected !== 1
      ) {
        throw new VerificationSessionClaimLostError()
      }
      if (
        activeNullifier
        && input.activeNullifierRefreshStatementIndex !== undefined
        && results[input.activeNullifierRefreshStatementIndex]?.rowsAffected !== 1
      ) {
        throw conflictError("Active identity changed during verification; please try again")
      }
      await transaction.commit()
    } catch (error) {
      try {
        await transaction.rollback()
      } catch (rollbackError) {
        console.error("[verification] identity batch rollback failed", rollbackError)
      }
      if (isUserAttestationUniqueConflict(error)) {
        throw new VerificationAttestationConflictError(error)
      }
      throw error
    } finally {
      transaction.close()
    }
  }

  const attemptedNullifierInsert = input.activeNullifier === null
  try {
    await writeBatch(input.activeNullifier)
    return
  } catch (error) {
    if (!attemptedNullifierInsert || !isActiveIdentityNullifierUniqueConflict(error)) throw error
    const winningNullifier = await getActiveIdentityNullifier(input.client, input.identityNullifier)
    if (!winningNullifier) throw error
    if (winningNullifier.userId !== input.userId) {
      throw eligibilityFailed("Identity proof is already linked to another user")
    }
    await writeBatch(winningNullifier)
  }
}

export async function returnCommittedVerificationAfterRace<T extends { status: string }>(input: {
  getSession: () => Promise<T | null>
  error: unknown
}): Promise<T> {
  const session = await input.getSession()
  if (session && session.status !== "pending") return session
  throw input.error
}
