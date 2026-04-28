import type { Client, InStatement } from "../sql-client"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import { getUserRow } from "../auth/auth-db-queries"
import { parseVerificationCapabilities } from "../auth/auth-serializers"
import type { VerificationSessionRow } from "../auth/auth-db-rows"
import { normalizeIdentityCountryCode } from "../identity/country-codes"
import type {
  RequestedVerificationCapability,
  VerificationRequirement,
  VerificationSession,
} from "../../types"
import { getAttestationsBySourceSessionId } from "./verification-shared"
import { getVerificationSession } from "./verification-session-read-service"
import {
  assertIdentityNullifierAvailable,
  resolveIdentityNullifier,
} from "./identity-nullifier-service"
import { resolveMinimumAgeToMint } from "./verification-requirements"

export async function finalizeVerification(
  client: Client,
  row: VerificationSessionRow,
  input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: unknown
    proofHash?: string | null
  },
  requestedCapabilities?: RequestedVerificationCapability[] | null,
  verificationRequirements?: VerificationRequirement[] | null,
  selfClaims?: { age_over_18: boolean; minimum_age?: number | null; nationality: string | null; gender: "M" | "F" | null; ofac_clear?: boolean | null; nullifier?: string | null } | null,
  attestationData?: Record<string, unknown>,
): Promise<VerificationSession> {
  const existingAttestations = await getAttestationsBySourceSessionId(client, input.verificationSessionId, input.userId)
  if (existingAttestations.some((a) => a.status === "accepted")) {
    return getVerificationSession(client, input.verificationSessionId, input.userId) as Promise<VerificationSession>
  }

  const now = new Date()
  const updatedAt = now.toISOString()
  const expiresAt = row.expires_at ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const userRow = await getUserRow(client, input.userId)
  if (!userRow) {
    throw internalError("User row missing while completing verification session")
  }

  const capabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  const capsToMint = requestedCapabilities ?? ["unique_human"]
  const minimumAgeToMint = resolveMinimumAgeToMint(capsToMint, verificationRequirements ?? [], selfClaims)
  const identityNullifier = await resolveIdentityNullifier({ row, selfClaims, attestationData })
  const activeNullifier = await client.execute({
    sql: `
      SELECT user_id
      FROM identity_nullifiers
      WHERE provider = ?1
        AND mechanism = ?2
        AND nullifier_hash = ?3
        AND status = 'active'
      LIMIT 1
    `,
    args: [identityNullifier.provider, identityNullifier.mechanism, identityNullifier.nullifierHash],
  })
  const activeNullifierUserId = typeof activeNullifier.rows[0]?.user_id === "string"
    ? activeNullifier.rows[0].user_id
    : null
  await assertIdentityNullifierAvailable({ activeNullifierUserId, userId: input.userId })

  const attestationInserts: InStatement[] = []
  const uniqueHumanAttestationId = makeId("att")

  capabilities.unique_human = {
    state: "verified",
    provider: row.provider === "self" || row.provider === "very" ? row.provider : null,
    proof_type: "unique_human",
    mechanism: row.provider === "very" ? "very_provider" : "session_complete",
    verified_at: updatedAt,
  }
  attestationInserts.push({
    sql: `
      INSERT INTO user_attestations (
        user_attestation_id, user_id, source_verification_session_id, provider, attestation_type,
        capability_key, status, value_json, verified_at, expires_at, revoked_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 'unique_human', 'unique_human', 'accepted', ?5, ?6, ?7, NULL, ?6, ?6)
    `,
    args: [uniqueHumanAttestationId, input.userId, input.verificationSessionId, row.provider, JSON.stringify({ state: "verified" }), updatedAt, expiresAt],
  })

  if (capsToMint.includes("age_over_18") && row.provider === "self") {
    capabilities.age_over_18 = {
      state: "verified",
      provider: "self",
      proof_type: "age_over_18",
      mechanism: "self_disclosure",
      verified_at: updatedAt,
    }
    attestationInserts.push({
      sql: `
        INSERT INTO user_attestations (
          user_attestation_id, user_id, source_verification_session_id, provider, attestation_type,
          capability_key, status, value_json, verified_at, expires_at, revoked_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'age_over_18', 'age_over_18', 'accepted', ?5, ?6, ?7, NULL, ?6, ?6)
      `,
      args: [makeId("att"), input.userId, input.verificationSessionId, row.provider, JSON.stringify({ state: "verified", age_over_18: true }), updatedAt, expiresAt],
    })
  }

  if (minimumAgeToMint != null && row.provider === "self") {
    capabilities.minimum_age = {
      state: "verified",
      value: minimumAgeToMint,
      provider: "self",
      proof_type: "minimum_age",
      mechanism: "self_disclosure",
      verified_at: updatedAt,
    }
    attestationInserts.push({
      sql: `
        INSERT INTO user_attestations (
          user_attestation_id, user_id, source_verification_session_id, provider, attestation_type,
          capability_key, status, value_json, verified_at, expires_at, revoked_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'minimum_age', 'minimum_age', 'accepted', ?5, ?6, ?7, NULL, ?6, ?6)
      `,
      args: [makeId("att"), input.userId, input.verificationSessionId, row.provider, JSON.stringify({ state: "verified", minimum_age: minimumAgeToMint }), updatedAt, expiresAt],
    })
  }

  if (capsToMint.includes("nationality") && row.provider === "self") {
    const nationalityValue = normalizeIdentityCountryCode(selfClaims?.nationality) ?? null
    capabilities.nationality = {
      state: "verified",
      value: nationalityValue,
      provider: "self",
      proof_type: "nationality",
      mechanism: "self_disclosure",
      verified_at: updatedAt,
    }
    attestationInserts.push({
      sql: `
        INSERT INTO user_attestations (
          user_attestation_id, user_id, source_verification_session_id, provider, attestation_type,
          capability_key, status, value_json, verified_at, expires_at, revoked_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'nationality', 'nationality', 'accepted', ?5, ?6, ?7, NULL, ?6, ?6)
      `,
      args: [makeId("att"), input.userId, input.verificationSessionId, row.provider, JSON.stringify({ state: "verified", nationality: nationalityValue }), updatedAt, expiresAt],
    })
  }

  if (capsToMint.includes("gender") && row.provider === "self") {
    const genderValue = selfClaims?.gender ?? null
    capabilities.gender = {
      state: "verified",
      value: genderValue,
      provider: "self",
      proof_type: "gender",
      mechanism: "self_disclosure",
      verified_at: updatedAt,
    }
    attestationInserts.push({
      sql: `
        INSERT INTO user_attestations (
          user_attestation_id, user_id, source_verification_session_id, provider, attestation_type,
          capability_key, status, value_json, verified_at, expires_at, revoked_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'gender', 'gender', 'accepted', ?5, ?6, ?7, NULL, ?6, ?6)
      `,
      args: [makeId("att"), input.userId, input.verificationSessionId, row.provider, JSON.stringify({ state: "verified", gender: genderValue }), updatedAt, expiresAt],
    })
  }

  const attestationProofHash = typeof attestationData?.proof_hash === "string" ? attestationData.proof_hash : null
  const resultRef = input.proofHash ?? attestationProofHash ?? null
  if (!activeNullifierUserId) {
    attestationInserts.push({
      sql: `
        INSERT INTO identity_nullifiers (
          identity_nullifier_id, user_id, provider, mechanism, nullifier_hash,
          source_verification_session_id, source_user_attestation_id, status,
          first_seen_at, revoked_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, NULL, ?8, ?8)
      `,
      args: [
        makeId("nul"),
        input.userId,
        identityNullifier.provider,
        identityNullifier.mechanism,
        identityNullifier.nullifierHash,
        input.verificationSessionId,
        uniqueHumanAttestationId,
        updatedAt,
      ],
    })
  }

  const batchStatements: InStatement[] = [
    {
      sql: `
        UPDATE verification_sessions
        SET status = 'verified',
            result_ref = ?2,
            failure_code = NULL,
            completed_at = ?3,
            updated_at = ?3
        WHERE verification_session_id = ?1
      `,
      args: [input.verificationSessionId, resultRef, updatedAt],
    },
    ...attestationInserts,
    {
      sql: `
        UPDATE users
        SET verification_state = 'verified',
            capability_provider = ?2,
            verification_capabilities_json = ?3,
            verified_at = ?4,
            current_verification_session_id = ?1,
            updated_at = ?4
        WHERE user_id = ?5
      `,
      args: [input.verificationSessionId, row.provider, JSON.stringify(capabilities), updatedAt, input.userId],
    },
  ]

  await client.batch(batchStatements, "write")

  return getVerificationSession(client, input.verificationSessionId, input.userId) as Promise<VerificationSession>
}
