import type { Client, InStatement } from "../sql-client"
import { badRequestError, eligibilityFailed, internalError, providerUnavailable } from "../errors"
import { makeId } from "../helpers"
import {
  getUserRow,
} from "../auth/auth-db-queries"
import {
  parseVerificationCapabilities,
  serializeVerificationSession,
} from "../auth/auth-serializers"
import type {
  VerificationSessionRow,
} from "../auth/auth-db-rows"
import type { VerySessionOutcome } from "./very-provider"
import { getVeryProvider } from "./very-provider"
import type { SelfSessionOutcome } from "./self-provider"
import { canonicalizeRequestedCapabilities, getSelfProvider } from "./self-provider"
import type {
  Env,
  RequestedVerificationCapability,
  VerificationIntent,
  VerificationSession,
  VerificationSessionLaunch,
} from "../../types"
import {
  getAttestationsBySourceSessionId,
  getVerificationSessionRowForUser,
} from "./control-plane-verification-shared"

export async function startVerificationSession(
  client: Client,
  env: Env,
  input: {
    userId: string
    provider: "self" | "very"
    requestedCapabilities?: RequestedVerificationCapability[] | null
    walletAttachmentId?: string | null
    verificationIntent?: VerificationIntent | null
    policyId?: string | null
  },
): Promise<VerificationSession> {
  const requestedCapabilities = canonicalizeRequestedCapabilities(input.provider, (input.requestedCapabilities?.length ? input.requestedCapabilities : ["unique_human"]) as RequestedVerificationCapability[])
  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const verificationSessionId = makeId("ver")

  let upstreamSessionRef: string | null = null
  let launch: VerificationSessionLaunch | null = null

  if (input.provider === "very") {
    for (const cap of requestedCapabilities) {
      if (cap !== "unique_human") {
        throw badRequestError("Only unique_human verification is supported for the very provider")
      }
    }
    const provider = getVeryProvider(env)
    const result = await provider.startSession({
      userId: input.userId,
      requestedCapabilities: requestedCapabilities.filter((c): c is "unique_human" => c === "unique_human"),
      walletAttachmentId: input.walletAttachmentId ?? null,
      verificationIntent: input.verificationIntent ?? null,
      policyId: input.policyId ?? null,
    })
    upstreamSessionRef = result.upstreamSessionRef
    launch = { mode: "widget", very_widget: result.launch }
  }

  if (input.provider === "self") {
    const provider = getSelfProvider(env)
    const result = await provider.startSession({
      userId: input.userId,
      requestedCapabilities,
      verificationIntent: input.verificationIntent ?? null,
      policyId: input.policyId ?? null,
    })
    upstreamSessionRef = result.upstreamSessionRef
    launch = { mode: "qr_deeplink", self_app: result.launch }
  }

  await client.execute({
    sql: `
      INSERT INTO verification_sessions (
        verification_session_id, user_id, provider, session_kind, requested_capabilities_json,
        status, upstream_session_ref, result_ref, failure_code,
        wallet_attachment_id, verification_intent, policy_id,
        started_at, completed_at, expires_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'identity_proof', ?4, 'pending', ?5, NULL, NULL, ?6, ?7, ?8, ?9, NULL, ?10, ?9, ?9)
    `,
    args: [
      verificationSessionId,
      input.userId,
      input.provider,
      JSON.stringify(requestedCapabilities),
      upstreamSessionRef,
      input.walletAttachmentId ?? null,
      input.verificationIntent ?? null,
      input.policyId ?? null,
      createdAt,
      expiresAt,
    ],
  })

  const row = await getVerificationSessionRowForUser(client, verificationSessionId, input.userId)
  if (!row) {
    throw internalError("Verification session row is missing after creation")
  }
  return serializeVerificationSession({ row, attestationRows: [], launch })
}

export async function getVerificationSession(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<VerificationSession | null> {
  const row = await getVerificationSessionRowForUser(client, verificationSessionId, userId)
  if (!row) {
    return null
  }
  const attestationRows = await getAttestationsBySourceSessionId(client, verificationSessionId, userId)
  return serializeVerificationSession({ row, attestationRows })
}

export async function completeVerificationSession(
  client: Client,
  env: Env,
  input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: string | null
    proofHash?: string | null
    providerPayloadRef?: string | null
  },
): Promise<VerificationSession | null> {
  const row = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
  if (!row) {
    return null
  }

  if (isTerminalStatus(row.status)) {
    const attestationRows = await getAttestationsBySourceSessionId(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row, attestationRows })
  }

  if (row.status !== "pending") {
    throw badRequestError("Session is not in a pollable state")
  }

  if (row.provider === "very") {
    return completeVerySession(client, env, row, input)
  }

  if (row.provider === "self") {
    return completeSelfSession(client, env, row, input)
  }

  const sessionExpiresAt = row.expires_at
  if (sessionExpiresAt && new Date(sessionExpiresAt) < new Date()) {
    throw eligibilityFailed("Verification session has expired")
  }

  return finalizeVerification(client, row, input)
}

function isTerminalStatus(status: string): boolean {
  return status === "verified" || status === "failed" || status === "expired"
}

async function completeVerySession(
  client: Client,
  env: Env,
  row: VerificationSessionRow,
  input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: string | null
    proofHash?: string | null
    providerPayloadRef?: string | null
  },
): Promise<VerificationSession> {
  if (!row.upstream_session_ref) {
    throw internalError("Very session has no upstream reference")
  }

  const sessionExpiresAt = row.expires_at
  if (sessionExpiresAt && new Date(sessionExpiresAt) < new Date()) {
    await client.execute({
      sql: `UPDATE verification_sessions SET status = 'expired', updated_at = ?2 WHERE verification_session_id = ?1`,
      args: [input.verificationSessionId, new Date().toISOString()],
    })
    const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
  }

  let outcome: VerySessionOutcome
  try {
    const provider = getVeryProvider(env)
    outcome = await provider.getSessionOutcome({
      upstreamSessionRef: row.upstream_session_ref,
      providerPayloadRef: input.providerPayloadRef ?? input.proof ?? null,
    })
  } catch (error) {
    throw providerUnavailable(
      error instanceof Error ? error.message : "Very provider is unavailable"
    )
  }

  if (outcome.status === "verified") {
    console.info("[very-provider] completion outcome", {
      verificationSessionId: input.verificationSessionId,
      outcome: outcome.status,
    })
    return finalizeVerification(client, row, input, null, null, outcome.attestationData)
  }

  if (outcome.status === "pending") {
    console.info("[very-provider] completion outcome", {
      verificationSessionId: input.verificationSessionId,
      outcome: outcome.status,
    })
    return serializeVerificationSession({ row, attestationRows: [] })
  }

  if (outcome.status === "failed") {
    console.warn("[very-provider] completion outcome", {
      verificationSessionId: input.verificationSessionId,
      outcome: outcome.status,
      failureReason: outcome.failureReason,
    })
    const updatedAt = new Date().toISOString()
    await client.execute({
      sql: `UPDATE verification_sessions SET status = 'failed', failure_code = ?2, updated_at = ?3 WHERE verification_session_id = ?1`,
      args: [input.verificationSessionId, outcome.failureReason, updatedAt],
    })
    const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
  }

  if (outcome.status === "expired") {
    console.warn("[very-provider] completion outcome", {
      verificationSessionId: input.verificationSessionId,
      outcome: outcome.status,
    })
    const updatedAt = new Date().toISOString()
    await client.execute({
      sql: `UPDATE verification_sessions SET status = 'expired', failure_code = 'provider_expired', updated_at = ?2 WHERE verification_session_id = ?1`,
      args: [input.verificationSessionId, updatedAt],
    })
    const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
  }

  return serializeVerificationSession({ row, attestationRows: [] })
}

async function completeSelfSession(
  client: Client,
  env: Env,
  row: VerificationSessionRow,
  input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: string | null
    proofHash?: string | null
    providerPayloadRef?: string | null
  },
): Promise<VerificationSession> {
  const sessionExpiresAt = row.expires_at
  if (sessionExpiresAt && new Date(sessionExpiresAt) < new Date()) {
    await client.execute({
      sql: `UPDATE verification_sessions SET status = 'expired', updated_at = ?2 WHERE verification_session_id = ?1`,
      args: [input.verificationSessionId, new Date().toISOString()],
    })
    const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
  }

  let outcome: SelfSessionOutcome
  try {
    const provider = getSelfProvider(env)
    outcome = await provider.getSessionOutcome({
      upstreamSessionRef: row.upstream_session_ref ?? input.verificationSessionId,
      proof: input.proof ?? null,
      providerPayloadRef: input.providerPayloadRef ?? null,
    })
  } catch (error) {
    throw providerUnavailable(
      error instanceof Error ? error.message : "Self provider is unavailable"
    )
  }

  if (outcome.status === "verified") {
    const requestedCapabilities = JSON.parse(row.requested_capabilities_json) as RequestedVerificationCapability[]
    const missingClaims: string[] = []
    if (requestedCapabilities.includes("age_over_18") && outcome.claims.age_over_18 !== true) {
      missingClaims.push("age_over_18")
    }
    if (requestedCapabilities.includes("nationality") && !outcome.claims.nationality) {
      missingClaims.push("nationality")
    }
    if (requestedCapabilities.includes("gender") && !outcome.claims.gender) {
      missingClaims.push("gender")
    }
    if (missingClaims.length > 0) {
      const updatedAt = new Date().toISOString()
      await client.execute({
        sql: `UPDATE verification_sessions SET status = 'failed', failure_code = ?2, updated_at = ?3 WHERE verification_session_id = ?1`,
        args: [input.verificationSessionId, `missing_required_claims:${missingClaims.join(",")}`, updatedAt],
      })
      const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
      return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
    }
    return finalizeVerification(client, row, input, requestedCapabilities, outcome.claims)
  }

  if (outcome.status === "pending") {
    return serializeVerificationSession({ row, attestationRows: [] })
  }

  if (outcome.status === "failed") {
    const updatedAt = new Date().toISOString()
    await client.execute({
      sql: `UPDATE verification_sessions SET status = 'failed', failure_code = ?2, updated_at = ?3 WHERE verification_session_id = ?1`,
      args: [input.verificationSessionId, outcome.failureReason, updatedAt],
    })
    const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
  }

  if (outcome.status === "expired") {
    const updatedAt = new Date().toISOString()
    await client.execute({
      sql: `UPDATE verification_sessions SET status = 'expired', failure_code = 'provider_expired', updated_at = ?2 WHERE verification_session_id = ?1`,
      args: [input.verificationSessionId, updatedAt],
    })
    const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
  }

  return serializeVerificationSession({ row, attestationRows: [] })
}

async function finalizeVerification(
  client: Client,
  row: VerificationSessionRow,
  input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: string | null
    proofHash?: string | null
  },
  requestedCapabilities?: RequestedVerificationCapability[] | null,
  selfClaims?: { age_over_18: boolean; nationality: string | null; gender: "M" | "F" | null } | null,
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
  const attestationInserts: InStatement[] = []

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
    args: [makeId("att"), input.userId, input.verificationSessionId, row.provider, JSON.stringify({ state: "verified" }), updatedAt, expiresAt],
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

  if (capsToMint.includes("nationality") && row.provider === "self") {
    const nationalityValue = selfClaims?.nationality ?? null
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
