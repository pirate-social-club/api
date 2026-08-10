import { auditEventInsert } from "../audit"
import type { DbExecutor } from "../db-helpers"
import { conflictError, verificationRequired } from "../errors"
import { makeId } from "../helpers"
import type { Client, QueryResultRow, Transaction } from "../sql-client"
import { withTransaction } from "../transactions"
import type { Env } from "../../env"
import {
  assertHnsRootLabel,
  normalizeHnsRootLabel,
  verifyHnsTxtRecord,
  type HnsVerifyTxtResult,
} from "../verification/hns-verifier"

const OWNERSHIP_LEASE_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1_000
const TRUSTED_PARENT_PROVIDER = "hsd_json_rpc"
const TRUSTED_OWNERSHIP_SOURCE = "hns_parent_chain_txt"

type RenewalCandidate = {
  challengeHost: string | null
  challengeTxtValue: string
  expiresAt: string
  lastOwnershipRevalidatedAt: string | null
  namespaceVerificationId: string
  sessionId: string
  status: "verified" | "stale"
}

export type HnsOwnershipLeaseRenewalResult = {
  applied: boolean
  namespaceVerificationId: string
  normalizedRootLabel: string
  outcome: "already_current" | "renewable" | "renewed" | "indeterminate" | "definitive_negative"
  previousExpiresAt: string
  renewedExpiresAt: string | null
  reasonCode: string
}

function requiredText(row: QueryResultRow, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) {
    throw conflictError(`HNS ownership lease candidate is missing ${key}`)
  }
  return value
}

function parseCandidate(row: QueryResultRow): RenewalCandidate {
  const status = row.status === "verified" ? "verified" : row.status === "stale" ? "stale" : null
  if (!status) throw conflictError("HNS ownership lease candidate has an invalid status")
  return {
    challengeHost: typeof row.challenge_host === "string" ? row.challenge_host : null,
    challengeTxtValue: requiredText(row, "challenge_txt_value"),
    expiresAt: requiredText(row, "expires_at"),
    lastOwnershipRevalidatedAt:
      typeof row.last_ownership_revalidated_at === "string"
        ? row.last_ownership_revalidated_at
        : null,
    namespaceVerificationId: requiredText(row, "namespace_verification_id"),
    sessionId: requiredText(row, "source_namespace_verification_session_id"),
    status,
  }
}

async function selectCandidate(
  executor: DbExecutor,
  normalizedRootLabel: string,
): Promise<RenewalCandidate> {
  const result = await executor.execute({
    sql: `
      SELECT
        verification.namespace_verification_id,
        verification.source_namespace_verification_session_id,
        verification.status,
        verification.expires_at,
        session.challenge_host,
        session.challenge_txt_value,
        (
          SELECT assertion.last_revalidated_at
          FROM namespace_verification_assertions AS assertion
          WHERE assertion.namespace_verification_id = verification.namespace_verification_id
            AND assertion.assertion_name = 'root_control_verified'
          ORDER BY assertion.updated_at DESC
          LIMIT 1
        ) AS last_ownership_revalidated_at
      FROM namespace_verifications AS verification
      JOIN namespace_verification_sessions AS session
        ON session.namespace_verification_session_id = verification.source_namespace_verification_session_id
      JOIN community_namespace_bindings AS binding
        ON binding.namespace_verification_id = verification.namespace_verification_id
       AND binding.status = 'active'
      JOIN communities AS community
        ON community.community_id = binding.community_id
       AND community.status = 'active'
      LEFT JOIN hns_root_delegation_state AS delegation
        ON delegation.normalized_root_label = verification.normalized_root_label
      WHERE verification.family = 'hns'
        AND verification.normalized_root_label = ?1
        AND verification.status IN ('verified', 'stale')
        -- A root can legitimately be unseeded because its ownership lease
        -- expired before the observer first ran. Legacy rows created before
        -- the non-null defaults were enforced can also still carry NULL.
        -- Both cases have always rendered as inactive at read time.
        -- TODO(2026-09-01, control-plane schema owner): remove COALESCE after
        -- the production constraint audit confirms no nullable rows remain.
        AND COALESCE(delegation.canonical_routing_eligible, 0) = 0
        AND COALESCE(delegation.routing_hard_denied, 0) = 0
      ORDER BY verification.updated_at DESC
      LIMIT 2
    `,
    args: [normalizedRootLabel],
  })
  if (result.rows.length === 0) {
    throw verificationRequired(
      "HNS root has no inactive, attached ownership verification eligible for renewal",
    )
  }
  if (result.rows.length !== 1) {
    throw conflictError("HNS root has multiple attached ownership verifications")
  }
  return parseCandidate(result.rows[0])
}

function parsedTime(value: string, label: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw conflictError(`${label} is invalid`)
  return parsed
}

function isRecentlyRenewed(candidate: RenewalCandidate, nowMs: number): boolean {
  const lastRevalidatedAt = candidate.lastOwnershipRevalidatedAt
    ? Date.parse(candidate.lastOwnershipRevalidatedAt)
    : Number.NaN
  const expiresAt = Date.parse(candidate.expiresAt)
  return candidate.status === "verified"
    && Number.isFinite(lastRevalidatedAt)
    && lastRevalidatedAt >= nowMs - IDEMPOTENCY_WINDOW_MS
    && Number.isFinite(expiresAt)
    && expiresAt >= nowMs + OWNERSHIP_LEASE_VALIDITY_MS - IDEMPOTENCY_WINDOW_MS
}

function observationOutcome(
  verification: HnsVerifyTxtResult,
  candidate: RenewalCandidate,
  normalizedRootLabel: string,
): { outcome: "renewable" | "indeterminate" | "definitive_negative"; reasonCode: string } {
  const observedValues = Array.isArray(verification.observed_values)
    ? verification.observed_values.filter((value): value is string => typeof value === "string")
    : []
  const exactChallengePresent = observedValues.includes(candidate.challengeTxtValue)

  if (observedValues.length === 0) {
    return { outcome: "indeterminate", reasonCode: "challenge_absence_indeterminate" }
  }
  if (!exactChallengePresent) {
    return { outcome: "definitive_negative", reasonCode: "stored_challenge_replaced" }
  }

  const echoedRoot = typeof verification.root_label === "string"
    ? normalizeHnsRootLabel(verification.root_label)
    : normalizedRootLabel
  const completeTrustedProof = verification.verified === true
    && echoedRoot === normalizedRootLabel
    && verification.ownership_source === TRUSTED_OWNERSHIP_SOURCE
    && verification.expiry_observation_provider === TRUSTED_PARENT_PROVIDER
    && verification.expiry_root_exists === true
    && verification.root_control_verified === true
    && verification.expiry_horizon_sufficient === true

  return completeTrustedProof
    ? { outcome: "renewable", reasonCode: "stored_challenge_confirmed" }
    : { outcome: "indeterminate", reasonCode: "ownership_proof_incomplete" }
}

function evidenceInsert(input: {
  candidate: RenewalCandidate
  evidenceBundleId: string
  normalizedRootLabel: string
  now: string
  outcome: string
  verification: HnsVerifyTxtResult
}) {
  return {
    sql: `
      INSERT INTO namespace_verification_evidence_bundles (
        evidence_bundle_id, namespace_verification_session_id, namespace_verification_id,
        family, normalized_root_label, evidence_kind, provider, resolver_path_json,
        raw_response_json, evidence_hash, observed_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'hns', ?4, 'revalidation_snapshot', ?5, ?6, ?7, NULL, ?8, ?8, ?8)
    `,
    args: [
      input.evidenceBundleId,
      input.candidate.sessionId,
      input.candidate.namespaceVerificationId,
      input.normalizedRootLabel,
      input.verification.observation_provider ?? null,
      JSON.stringify([
        input.verification.observation_provider,
        input.verification.expiry_observation_provider,
      ].filter((value): value is string => typeof value === "string" && value.length > 0)),
      JSON.stringify({
        revalidation_outcome: input.outcome,
        previous_expires_at: input.candidate.expiresAt,
        verification: input.verification,
      }),
      input.now,
    ],
  }
}

async function assertCandidateUnchanged(
  tx: Transaction,
  normalizedRootLabel: string,
  expected: RenewalCandidate,
): Promise<void> {
  const current = await selectCandidate(tx, normalizedRootLabel)
  if (
    current.namespaceVerificationId !== expected.namespaceVerificationId
    || current.sessionId !== expected.sessionId
    || current.status !== expected.status
    || current.expiresAt !== expected.expiresAt
    || current.challengeTxtValue !== expected.challengeTxtValue
  ) {
    throw conflictError("HNS ownership lease candidate changed during revalidation")
  }
}

async function applyRenewal(input: {
  candidate: RenewalCandidate
  client: Client
  normalizedRootLabel: string
  now: string
  operatorActorId: string
  reason: string
  renewedExpiresAt: string
  verification: HnsVerifyTxtResult
}): Promise<void> {
  await withTransaction(input.client, "write", async (tx) => {
    await assertCandidateUnchanged(tx, input.normalizedRootLabel, input.candidate)
    const evidenceBundleId = makeId("nev")
    await tx.execute(evidenceInsert({
      candidate: input.candidate,
      evidenceBundleId,
      normalizedRootLabel: input.normalizedRootLabel,
      now: input.now,
      outcome: "renewed",
      verification: input.verification,
    }))
    const verificationWrite = await tx.execute({
      sql: `
        UPDATE namespace_verifications
        SET status = 'verified',
            root_exists = 1,
            root_control_verified = 1,
            expiry_horizon_sufficient = 1,
            club_attach_allowed = 1,
            observation_provider = ?2,
            evidence_bundle_ref = ?3,
            expires_at = ?4,
            updated_at = ?5
        WHERE namespace_verification_id = ?1
          AND status = ?6
          AND expires_at = ?7
      `,
      args: [
        input.candidate.namespaceVerificationId,
        input.verification.observation_provider ?? TRUSTED_PARENT_PROVIDER,
        evidenceBundleId,
        input.renewedExpiresAt,
        input.now,
        input.candidate.status,
        input.candidate.expiresAt,
      ],
    })
    if ((verificationWrite.rowsAffected ?? 0) !== 1) {
      throw conflictError("HNS ownership lease changed concurrently")
    }
    const sessionWrite = await tx.execute({
      sql: `
        UPDATE namespace_verification_sessions
        SET status = 'verified',
            root_exists = 1,
            root_control_verified = 1,
            expiry_horizon_sufficient = 1,
            club_attach_allowed = 1,
            observation_provider = ?2,
            evidence_bundle_ref = ?3,
            failure_reason = NULL,
            expires_at = ?4,
            updated_at = ?5
        WHERE namespace_verification_session_id = ?1
          AND challenge_txt_value = ?6
      `,
      args: [
        input.candidate.sessionId,
        input.verification.observation_provider ?? TRUSTED_PARENT_PROVIDER,
        evidenceBundleId,
        input.renewedExpiresAt,
        input.now,
        input.candidate.challengeTxtValue,
      ],
    })
    if ((sessionWrite.rowsAffected ?? 0) !== 1) {
      throw conflictError("HNS ownership session changed concurrently")
    }
    await tx.execute({
      sql: `
        UPDATE namespace_verification_assertions
        SET assertion_value = 1,
            status = 'accepted',
            source_evidence_bundle_id = ?2,
            first_accepted_at = COALESCE(first_accepted_at, ?3),
            last_revalidated_at = ?3,
            updated_at = ?3
        WHERE namespace_verification_id = ?1
          AND assertion_name IN ('root_exists', 'root_control_verified', 'expiry_horizon_sufficient')
      `,
      args: [input.candidate.namespaceVerificationId, evidenceBundleId, input.now],
    })
    await tx.execute({
      sql: `
        UPDATE namespace_verification_capabilities
        SET capability_value = 1,
            status = 'accepted',
            source_evidence_bundle_id = ?2,
            first_accepted_at = COALESCE(first_accepted_at, ?3),
            last_revalidated_at = ?3,
            updated_at = ?3
        WHERE namespace_verification_id = ?1
          AND capability_name = 'club_attach_allowed'
      `,
      args: [input.candidate.namespaceVerificationId, evidenceBundleId, input.now],
    })
    await tx.execute(auditEventInsert({
      action: "hns_namespace.ownership_lease_renew",
      actorId: input.operatorActorId,
      actorType: "operator",
      createdAt: input.now,
      metadata: {
        reason: input.reason,
        previous_expires_at: input.candidate.expiresAt,
        renewed_expires_at: input.renewedExpiresAt,
        lease_policy: "fixed_30_days_from_verified_observation",
        ownership_source: TRUSTED_OWNERSHIP_SOURCE,
        provider: TRUSTED_PARENT_PROVIDER,
      },
      targetId: input.candidate.namespaceVerificationId,
      targetType: "namespace_verification",
    }))
  })
}

async function applyDefinitiveNegative(input: {
  candidate: RenewalCandidate
  client: Client
  normalizedRootLabel: string
  now: string
  operatorActorId: string
  reason: string
  verification: HnsVerifyTxtResult
}): Promise<void> {
  await withTransaction(input.client, "write", async (tx) => {
    await assertCandidateUnchanged(tx, input.normalizedRootLabel, input.candidate)
    const evidenceBundleId = makeId("nev")
    await tx.execute(evidenceInsert({
      candidate: input.candidate,
      evidenceBundleId,
      normalizedRootLabel: input.normalizedRootLabel,
      now: input.now,
      outcome: "definitive_negative",
      verification: input.verification,
    }))
    const write = await tx.execute({
      sql: `
        UPDATE namespace_verifications
        SET status = 'stale',
            root_control_verified = 0,
            club_attach_allowed = 0,
            evidence_bundle_ref = ?2,
            updated_at = ?3
        WHERE namespace_verification_id = ?1
          AND status = ?4
          AND expires_at = ?5
      `,
      args: [
        input.candidate.namespaceVerificationId,
        evidenceBundleId,
        input.now,
        input.candidate.status,
        input.candidate.expiresAt,
      ],
    })
    if ((write.rowsAffected ?? 0) !== 1) {
      throw conflictError("HNS ownership lease changed concurrently")
    }
    await tx.execute({
      sql: `
        UPDATE namespace_verification_assertions
        SET assertion_value = 0,
            status = 'stale',
            source_evidence_bundle_id = ?2,
            last_revalidated_at = ?3,
            updated_at = ?3
        WHERE namespace_verification_id = ?1
          AND assertion_name = 'root_control_verified'
      `,
      args: [input.candidate.namespaceVerificationId, evidenceBundleId, input.now],
    })
    await tx.execute({
      sql: `
        UPDATE namespace_verification_capabilities
        SET capability_value = 0,
            status = 'stale',
            source_evidence_bundle_id = ?2,
            last_revalidated_at = ?3,
            updated_at = ?3
        WHERE namespace_verification_id = ?1
      `,
      args: [input.candidate.namespaceVerificationId, evidenceBundleId, input.now],
    })
    await tx.execute(auditEventInsert({
      action: "hns_namespace.ownership_lease_revalidation_failed",
      actorId: input.operatorActorId,
      actorType: "operator",
      createdAt: input.now,
      metadata: {
        reason: input.reason,
        failure_reason: "stored_challenge_replaced",
      },
      targetId: input.candidate.namespaceVerificationId,
      targetType: "namespace_verification",
    }))
  })
}

export async function renewHnsOwnershipLease(input: {
  apply: boolean
  client: Client
  env: Env
  now?: string
  operatorActorId: string
  reason: string
  rootLabel: string
}): Promise<HnsOwnershipLeaseRenewalResult> {
  const normalizedRootLabel = normalizeHnsRootLabel(input.rootLabel)
  assertHnsRootLabel(normalizedRootLabel)
  const operatorActorId = input.operatorActorId.trim()
  if (!/^[a-z][a-z0-9_]{2,63}$/u.test(operatorActorId)) {
    throw conflictError("HNS ownership lease renewal actor is invalid")
  }
  const reason = input.reason.trim()
  if (reason.length < 3 || reason.length > 500) {
    throw conflictError("HNS ownership lease renewal reason is invalid")
  }
  const now = input.now ?? new Date().toISOString()
  const nowMs = parsedTime(now, "HNS ownership lease renewal time")
  const candidate = await selectCandidate(input.client, normalizedRootLabel)

  if (isRecentlyRenewed(candidate, nowMs)) {
    return {
      applied: false,
      namespaceVerificationId: candidate.namespaceVerificationId,
      normalizedRootLabel,
      outcome: "already_current",
      previousExpiresAt: candidate.expiresAt,
      renewedExpiresAt: candidate.expiresAt,
      reasonCode: "renewed_within_idempotency_window",
    }
  }

  // This is the only verifier call in the operation. verify-txt-public reads
  // the parent chain; it cannot provision a zone, rotate a key, or publish a
  // record. Ownership is compared with this verification's stored nonce.
  const verification = await verifyHnsTxtRecord(input.env, {
    rootLabel: normalizedRootLabel,
    challengeHost: candidate.challengeHost,
    challengeTxtValue: candidate.challengeTxtValue,
  })
  const observation = observationOutcome(verification, candidate, normalizedRootLabel)

  if (observation.outcome === "indeterminate") {
    return {
      applied: false,
      namespaceVerificationId: candidate.namespaceVerificationId,
      normalizedRootLabel,
      outcome: observation.outcome,
      previousExpiresAt: candidate.expiresAt,
      renewedExpiresAt: null,
      reasonCode: observation.reasonCode,
    }
  }

  if (observation.outcome === "definitive_negative") {
    if (input.apply) {
      await applyDefinitiveNegative({
        candidate,
        client: input.client,
        normalizedRootLabel,
        now,
        operatorActorId,
        reason,
        verification,
      })
    }
    return {
      applied: input.apply,
      namespaceVerificationId: candidate.namespaceVerificationId,
      normalizedRootLabel,
      outcome: observation.outcome,
      previousExpiresAt: candidate.expiresAt,
      renewedExpiresAt: null,
      reasonCode: observation.reasonCode,
    }
  }

  const renewedExpiresAt = new Date(nowMs + OWNERSHIP_LEASE_VALIDITY_MS).toISOString()
  if (input.apply) {
    await applyRenewal({
      candidate,
      client: input.client,
      normalizedRootLabel,
      now,
      operatorActorId,
      reason,
      renewedExpiresAt,
      verification,
    })
  }
  return {
    applied: input.apply,
    namespaceVerificationId: candidate.namespaceVerificationId,
    normalizedRootLabel,
    outcome: input.apply ? "renewed" : "renewable",
    previousExpiresAt: candidate.expiresAt,
    renewedExpiresAt,
    reasonCode: observation.reasonCode,
  }
}
