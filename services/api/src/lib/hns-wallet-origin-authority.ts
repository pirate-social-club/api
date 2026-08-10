import { auditEventInsert } from "./audit"
import type { DbExecutor } from "./db-helpers"
import type { Client } from "./sql-client"
import { conflictError, notFoundError, verificationRequired } from "./errors"
import { normalizeRootLabel } from "./verification/labels"
import { withTransaction } from "./transactions"
import type { HnsWalletOriginAuthoritySnapshot } from "./hns-wallet-origin-authority-do"

type AuthorityRow = Record<string, unknown>
type TransactionalDbClient = Pick<Client, "execute" | "transaction">

export type HnsWalletOriginAuthorityState = HnsWalletOriginAuthoritySnapshot & {
  registrationStatus: "registered" | "revoked"
  registrationReference: string
}

function requiredRootLabel(value: string): string {
  const normalized = normalizeRootLabel(value)
  if (!normalized || normalized.includes(".")) {
    throw notFoundError("HNS root not found")
  }
  return normalized
}

function walletOriginHostname(rootLabel: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(rootLabel)) {
    throw conflictError("HNS root cannot be registered as a browser wallet origin")
  }
  return `app.${rootLabel}`
}

function parseAuthorityRow(row: AuthorityRow): HnsWalletOriginAuthorityState {
  const rootLabel = String(row.normalized_root_label)
  const registrationStatus = row.registration_status === "registered" ? "registered" : "revoked"
  const activated = Number(row.canonical_routing_eligible) === 1
  const hardDenied = Number(row.routing_hard_denied) === 1
  const effective = registrationStatus === "registered" && activated && !hardDenied
  const reasonCode = hardDenied
    ? "hard_denied"
    : registrationStatus === "revoked"
      ? "revoked"
      : !activated
        ? "not_activated"
        : "enabled"

  return {
    authorityVersion: Number(row.authority_version),
    effective,
    originHostname: `app.${rootLabel}`,
    reasonCode,
    registrationReference: String(row.registration_reference),
    registrationStatus,
    updatedAt: String(row.updated_at),
  }
}

async function selectAuthority(
  executor: DbExecutor,
  rootLabel: string,
): Promise<HnsWalletOriginAuthorityState | null> {
  const result = await executor.execute({
    sql: `
      SELECT authority.normalized_root_label, authority.registration_status,
             authority.authority_version, authority.registration_reference,
             authority.updated_at, state.canonical_routing_eligible,
             state.routing_hard_denied
      FROM hns_wallet_origin_authority AS authority
      JOIN hns_root_delegation_state AS state
        ON state.normalized_root_label = authority.normalized_root_label
      WHERE authority.normalized_root_label = ?1
      LIMIT 1
    `,
    args: [rootLabel],
  })
  return result.rows[0] ? parseAuthorityRow(result.rows[0]) : null
}

export async function readHnsWalletOriginAuthority(
  executor: DbExecutor,
  rootLabel: string,
): Promise<HnsWalletOriginAuthorityState | null> {
  return await selectAuthority(executor, requiredRootLabel(rootLabel))
}

function registrationReference(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(normalized)) {
    throw conflictError("Wallet origin registration reference is invalid")
  }
  return normalized
}

function operatorReason(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 3 || normalized.length > 500) {
    throw conflictError("Wallet origin reason is invalid")
  }
  return normalized
}

export async function registerHnsWalletOrigin(input: {
  executor: TransactionalDbClient
  rootLabel: string
  operatorActorId: string
  registrationReference: string
  reason: string
  now?: string
}): Promise<HnsWalletOriginAuthorityState> {
  const rootLabel = requiredRootLabel(input.rootLabel)
  const originHostname = walletOriginHostname(rootLabel)
  const reference = registrationReference(input.registrationReference)
  const reason = operatorReason(input.reason)
  const now = input.now ?? new Date().toISOString()

  return await withTransaction(input.executor, "write", async (tx) => {
    const eligible = await tx.execute({
      sql: `
        SELECT state.canonical_routing_eligible, state.routing_hard_denied
        FROM hns_root_delegation_state AS state
        WHERE state.normalized_root_label = ?1
        LIMIT 1
      `,
      args: [rootLabel],
    })
    const state = eligible.rows[0]
    if (!state || Number(state.canonical_routing_eligible) !== 1) {
      throw verificationRequired("HNS root must be activated before wallet registration")
    }
    if (Number(state.routing_hard_denied) === 1) {
      throw conflictError("HNS root is hard-denied")
    }

    const current = await selectAuthority(tx, rootLabel)
    if (
      current?.registrationStatus === "registered"
      && current.registrationReference === reference
    ) {
      return current
    }

    const write = current
      ? await tx.execute({
          sql: `
            UPDATE hns_wallet_origin_authority
            SET registration_status = 'registered',
                authority_version = authority_version + 1,
                registration_reference = ?2,
                registered_at = ?3,
                registered_by = ?4,
                revoked_at = NULL,
                revoked_by = NULL,
                revocation_reason = NULL,
                updated_at = ?3
            WHERE normalized_root_label = ?1
              AND authority_version = ?5
          `,
          args: [rootLabel, reference, now, input.operatorActorId, current.authorityVersion],
        })
      : await tx.execute({
          sql: `
            INSERT INTO hns_wallet_origin_authority (
              normalized_root_label, origin_hostname, registration_status,
              authority_version, registration_reference, registered_at,
              registered_by, revoked_at, revoked_by, revocation_reason,
              created_at, updated_at
            ) VALUES (?1, ?2, 'registered', 1, ?3, ?4, ?5, NULL, NULL, NULL, ?4, ?4)
          `,
          args: [rootLabel, originHostname, reference, now, input.operatorActorId],
        })
    if ((write.rowsAffected ?? 0) !== 1) {
      throw conflictError("Wallet origin authority changed concurrently")
    }

    await tx.execute(auditEventInsert({
      action: "hns_wallet_origin.register",
      actorId: input.operatorActorId,
      actorType: "operator",
      createdAt: now,
      metadata: { reason, registration_reference: reference },
      targetId: rootLabel,
      targetType: "hns_root",
    }))
    const updated = await selectAuthority(tx, rootLabel)
    if (!updated) throw conflictError("Wallet origin authority was not persisted")
    return updated
  })
}

export async function revokeHnsWalletOrigin(input: {
  executor: TransactionalDbClient
  rootLabel: string
  operatorActorId: string
  reason: string
  now?: string
}): Promise<HnsWalletOriginAuthorityState> {
  const rootLabel = requiredRootLabel(input.rootLabel)
  const reason = operatorReason(input.reason)
  const now = input.now ?? new Date().toISOString()

  return await withTransaction(input.executor, "write", async (tx) => {
    const current = await selectAuthority(tx, rootLabel)
    if (!current) throw notFoundError("Wallet origin registration not found")
    if (current.registrationStatus === "revoked") return current

    const write = await tx.execute({
      sql: `
        UPDATE hns_wallet_origin_authority
        SET registration_status = 'revoked',
            authority_version = authority_version + 1,
            revoked_at = ?2,
            revoked_by = ?3,
            revocation_reason = ?4,
            updated_at = ?2
        WHERE normalized_root_label = ?1
          AND authority_version = ?5
          AND registration_status = 'registered'
      `,
      args: [rootLabel, now, input.operatorActorId, reason, current.authorityVersion],
    })
    if ((write.rowsAffected ?? 0) !== 1) {
      throw conflictError("Wallet origin authority changed concurrently")
    }

    await tx.execute(auditEventInsert({
      action: "hns_wallet_origin.revoke",
      actorId: input.operatorActorId,
      actorType: "operator",
      createdAt: now,
      metadata: { reason },
      targetId: rootLabel,
      targetType: "hns_root",
    }))
    const updated = await selectAuthority(tx, rootLabel)
    if (!updated) throw conflictError("Wallet origin authority was not persisted")
    return updated
  })
}

export async function hardDenyHnsRootRouting(input: {
  executor: TransactionalDbClient
  rootLabel: string
  operatorActorId: string
  reason: string
  now?: string
}): Promise<HnsWalletOriginAuthorityState | null> {
  const rootLabel = requiredRootLabel(input.rootLabel)
  const reason = operatorReason(input.reason)
  const now = input.now ?? new Date().toISOString()

  return await withTransaction(input.executor, "write", async (tx) => {
    const state = await tx.execute({
      sql: `
        SELECT routing_hard_denied
        FROM hns_root_delegation_state
        WHERE normalized_root_label = ?1
        LIMIT 1
      `,
      args: [rootLabel],
    })
    if (!state.rows[0]) throw notFoundError("HNS root observer state not found")

    const authority = await selectAuthority(tx, rootLabel)
    const stateWrite = await tx.execute({
      sql: `
        UPDATE hns_root_delegation_state
        SET routing_hard_denied = 1,
            canonical_routing_eligible = 0,
            updated_at = ?2
        WHERE normalized_root_label = ?1
      `,
      args: [rootLabel, now],
    })
    if ((stateWrite.rowsAffected ?? 0) !== 1) {
      throw conflictError("HNS root routing state changed concurrently")
    }

    if (authority) {
      const authorityWrite = await tx.execute({
        sql: `
          UPDATE hns_wallet_origin_authority
          SET authority_version = authority_version + 1,
              updated_at = ?2
          WHERE normalized_root_label = ?1
            AND authority_version = ?3
        `,
        args: [rootLabel, now, authority.authorityVersion],
      })
      if ((authorityWrite.rowsAffected ?? 0) !== 1) {
        throw conflictError("Wallet origin authority changed concurrently")
      }
    }

    await tx.execute(auditEventInsert({
      action: "hns_root.routing_hard_deny",
      actorId: input.operatorActorId,
      actorType: "operator",
      createdAt: now,
      metadata: { reason, wallet_origin_registered: authority !== null },
      targetId: rootLabel,
      targetType: "hns_root",
    }))
    return await selectAuthority(tx, rootLabel)
  })
}
