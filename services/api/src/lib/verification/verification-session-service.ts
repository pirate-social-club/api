import type { Client, InStatement } from "../sql-client"
import { badRequestError, eligibilityFailed, internalError, providerUnavailable } from "../errors"
import { makeId } from "../helpers"
import { sha256Hex } from "../crypto"
import {
  getUserRow,
} from "../auth/auth-db-user-queries"
import {
  parseVerificationCapabilities,
  serializeVerificationSession,
} from "../auth/auth-serializers"
import type {
  VerificationSessionRow,
} from "../auth/auth-db-rows"
import type { VerySessionOutcome } from "./very-provider"
import { assertVeryNativeOAuthConfigured, buildVerySessionBinding, getVeryProvider, VERY_UNIQUE_HUMAN_DOMAIN } from "./very-provider"
import type { SelfSessionOutcome } from "./self-provider"
import { canonicalizeRequestedCapabilities, getSelfProvider, normalizeVerificationRequirements } from "./self-provider"
import { normalizeIdentityCountryCode } from "../identity/country-codes"
import { logVerificationDebug } from "./verification-logging"
import { unixSeconds } from "../../serializers/time"
import { parseJsonField } from "../json"
import type {
  Env,
  RequestedVerificationCapability,
  VerificationRequirement,
  VerificationIntent,
  VerificationSession,
  VerificationSessionLaunch,
} from "../../types"
import {
  getAttestationsBySourceSessionId,
  getVerificationSessionRow,
  getVerificationSessionRowForUser,
} from "./verification-shared"

function parseVerificationRequirements(raw: string | null | undefined): VerificationRequirement[] {
  if (!raw) return []
  const parsed = parseJsonField<unknown>(raw, "verification_sessions.verification_requirements_json")
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((requirement): VerificationRequirement[] => {
    if (requirement == null || typeof requirement !== "object") {
      return []
    }
    const typed = requirement as VerificationRequirement
    if (typed.proof_type === "minimum_age" && Number.isInteger(typed.minimum_age)) {
      return [typed]
    }
    if (typed.proof_type === "nationality" && Array.isArray(typed.required_values)) {
      return [typed]
    }
    return []
  })
}

type VerificationProviderMode = "qr_deeplink" | "widget" | "native_sdk"

function resolveProviderMode(provider: "self" | "very", providerMode: VerificationProviderMode | null | undefined): VerificationProviderMode {
  if (
    providerMode
    && providerMode !== "qr_deeplink"
    && providerMode !== "widget"
    && providerMode !== "native_sdk"
  ) {
    throw badRequestError("Unsupported verification provider_mode")
  }

  if (provider === "self") {
    if (providerMode && providerMode !== "qr_deeplink") {
      throw badRequestError("Self verification sessions only support qr_deeplink provider_mode")
    }
    return "qr_deeplink"
  }

  if (providerMode === "qr_deeplink") {
    throw badRequestError("Very verification sessions do not support qr_deeplink provider_mode")
  }
  return providerMode ?? "widget"
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseVeryNativeCompletionPayload(value: unknown): { code: string } | null {
  const record = readRecord(value)
  if (!record || record.mode !== "native_sdk") {
    return null
  }
  const code = typeof record.code === "string" ? record.code.trim() : ""
  if (!code) {
    throw badRequestError("Very native SDK completion requires an authorization code")
  }
  return { code }
}

function nativeAuthCodeTtlMs(env: Env): number {
  const raw = Number.parseInt(String(env.VERY_NATIVE_AUTH_CODE_TTL_SECONDS || "300"), 10)
  return (Number.isInteger(raw) && raw > 0 ? raw : 300) * 1000
}

function resolveMinimumAgeToMint(
  requestedCapabilities: RequestedVerificationCapability[],
  verificationRequirements: VerificationRequirement[],
  selfClaims: { age_over_18: boolean; minimum_age?: number | null } | null | undefined,
): number | null {
  const candidates: number[] = []
  for (const requirement of verificationRequirements) {
    if (requirement.proof_type !== "minimum_age") {
      continue
    }
    const minimumAge = requirement.minimum_age
    if (typeof minimumAge === "number" && Number.isInteger(minimumAge)) {
      candidates.push(minimumAge)
    }
  }
  if (requestedCapabilities.includes("age_over_18")) {
    candidates.push(18)
  }
  if (selfClaims?.minimum_age != null) {
    candidates.push(selfClaims.minimum_age)
  }
  if (candidates.length === 0) {
    return null
  }
  return Math.max(...candidates)
}

export async function startVerificationSession(
  client: Client,
  env: Env,
  input: {
    userId: string
    provider: "self" | "very"
    providerMode?: VerificationProviderMode | null
    requestedCapabilities?: RequestedVerificationCapability[] | null
    verificationRequirements?: VerificationRequirement[] | null
    walletAttachmentId?: string | null
    verificationIntent?: VerificationIntent | null
    policyId?: string | null
    publicOrigin?: string | null
  },
): Promise<VerificationSession> {
  const requestedCapabilities = canonicalizeRequestedCapabilities(input.provider, (input.requestedCapabilities?.length ? input.requestedCapabilities : ["unique_human"]) as RequestedVerificationCapability[])
  const verificationRequirements = normalizeVerificationRequirements(input.provider, input.verificationRequirements)
  const providerMode = resolveProviderMode(input.provider, input.providerMode ?? null)
  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const verificationSessionId = makeId("ver")

  logVerificationDebug(env, "[verification-session-service] normalized start", {
    verificationSessionId,
    userId: input.userId,
    provider: input.provider,
    requestedCapabilities,
    verificationRequirements,
    providerMode,
    verificationIntent: input.verificationIntent ?? null,
    policyId: input.policyId ?? null,
    publicOrigin: input.publicOrigin ?? null,
  })

  let upstreamSessionRef: string | null = null
  let launch: VerificationSessionLaunch | null = null

  if (input.provider === "very") {
    for (const cap of requestedCapabilities) {
      if (cap !== "unique_human") {
        throw badRequestError("Only unique_human verification is supported for the very provider")
      }
    }
    if (providerMode === "native_sdk") {
      assertVeryNativeOAuthConfigured(env)
      launch = { mode: "native_sdk" } as VerificationSessionLaunch
    } else {
      const provider = getVeryProvider(env)
      const result = await provider.startSession({
        verificationSessionId,
        userId: input.userId,
        requestedCapabilities: requestedCapabilities.filter((c): c is "unique_human" => c === "unique_human"),
        walletAttachmentId: input.walletAttachmentId ?? null,
        verificationIntent: input.verificationIntent ?? null,
        policyId: input.policyId ?? null,
        challengeExpiresAt: expiresAt,
        publicOrigin: input.publicOrigin ?? null,
      })
      upstreamSessionRef = result.upstreamSessionRef
      launch = { mode: "widget", very_widget: result.launch }
    }
  }

  if (input.provider === "self") {
    const provider = getSelfProvider(env)
    const result = await provider.startSession({
      verificationSessionId,
      userId: input.userId,
      publicOrigin: input.publicOrigin ?? null,
      requestedCapabilities,
      verificationRequirements,
      verificationIntent: input.verificationIntent ?? null,
      policyId: input.policyId ?? null,
    })
    upstreamSessionRef = result.upstreamSessionRef
    launch = { mode: "qr_deeplink", self_app: result.launch }
  }

  await client.execute({
    sql: `
      INSERT INTO verification_sessions (
        verification_session_id, user_id, provider, provider_mode, session_kind, requested_capabilities_json,
        verification_requirements_json, status, upstream_session_ref, result_ref, failure_code,
        wallet_attachment_id, verification_intent, policy_id,
        started_at, completed_at, expires_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 'identity_proof', ?5, ?6, 'pending', ?7, NULL, NULL, ?8, ?9, ?10, ?11, NULL, ?12, ?11, ?11)
    `,
    args: [
      verificationSessionId,
      input.userId,
      input.provider,
      providerMode,
      JSON.stringify(requestedCapabilities),
      JSON.stringify(verificationRequirements),
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
  logVerificationDebug(env, "[verification-session-service] created row", {
    verificationSessionId,
    userId: input.userId,
    provider: input.provider,
    requestedCapabilities,
    verificationRequirements,
    status: row.status,
    launchMode: launch?.mode ?? null,
    selfDisclosures: launch?.self_app?.disclosures ?? null,
    selfEndpointType: launch?.self_app?.endpoint_type ?? null,
    selfScope: launch?.self_app?.scope ?? null,
  })
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

export async function recordVeryBridgeSession(
  client: Client,
  input: {
    verificationSessionId: string
    userId: string
    providerSessionId: string
  },
): Promise<boolean | null> {
  if (!input.providerSessionId.trim() || input.providerSessionId.includes("/")) {
    throw badRequestError("Invalid Very bridge session id")
  }
  const row = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
  if (!row) {
    return null
  }
  if (row.provider !== "very") {
    throw badRequestError("Verification session is not a Very session")
  }
  if (row.provider_mode === "native_sdk") {
    throw badRequestError("Very native SDK sessions cannot record bridge session ids")
  }
  if (row.status !== "pending") {
    throw badRequestError("Session is not in a pollable state")
  }

  await client.execute({
    sql: `UPDATE verification_sessions SET upstream_session_ref = ?2, updated_at = ?3 WHERE verification_session_id = ?1`,
    args: [input.verificationSessionId, input.providerSessionId.trim(), new Date().toISOString()],
  })
  return true
}

export async function completeVerificationSession(
  client: Client,
  env: Env,
  input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: unknown
    proofHash?: string | null
    providerPayloadRef?: unknown
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

export async function completeSelfVerificationCallback(
  client: Client,
  env: Env,
  input: {
    verificationSessionId: string
    payload: Record<string, unknown>
  },
): Promise<VerificationSession | null> {
  const row = await getVerificationSessionRow(client, input.verificationSessionId)
  if (!row) {
    return null
  }
  if (row.provider !== "self") {
    throw badRequestError("Verification session is not a Self session")
  }
  const providerPayload = input.payload.payload != null
    && typeof input.payload.payload === "object"
    && !Array.isArray(input.payload.payload)
    ? input.payload.payload as Record<string, unknown>
    : input.payload
  return completeSelfSession(client, env, row, {
    verificationSessionId: input.verificationSessionId,
    userId: row.user_id,
    attestationId: typeof providerPayload.attestationId === "string"
      ? providerPayload.attestationId
      : typeof providerPayload.attestation_id === "string"
        ? providerPayload.attestation_id
        : null,
    proof: null,
    proofHash: null,
    providerPayloadRef: JSON.stringify(providerPayload),
  })
}

function isTerminalStatus(status: string): boolean {
  return status === "verified" || status === "failed" || status === "expired"
}

function providerErrorDetails(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof Error)) {
    return null
  }
  const details = (error as Error & { details?: unknown }).details
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return details as Record<string, unknown>
  }
  return null
}

type VerificationCompletionInput = {
  verificationSessionId: string
  userId: string
  attestationId?: string | null
  proof?: unknown
  proofHash?: string | null
  providerPayloadRef?: unknown
}

async function selfCompletionDiagnostics(
  row: VerificationSessionRow,
  input: VerificationCompletionInput,
): Promise<Record<string, unknown>> {
  const providerPayloadRef = typeof input.providerPayloadRef === "string" ? input.providerPayloadRef : null
  const proof = typeof input.proof === "string" ? input.proof : null
  const createdAtMs = Date.parse(row.created_at)
  return {
    verificationSessionId: input.verificationSessionId,
    userId: input.userId,
    currentStatus: row.status,
    existingFailureCode: row.failure_code,
    verificationIntent: row.verification_intent,
    policyId: row.policy_id,
    walletAttachmentId: row.wallet_attachment_id,
    requestedCapabilities: parseJsonField<RequestedVerificationCapability[]>(
      row.requested_capabilities_json,
      "verification_sessions.requested_capabilities_json",
    ),
    verificationRequirements: parseVerificationRequirements(row.verification_requirements_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    ageSeconds: Number.isFinite(createdAtMs) ? Math.max(0, Math.round((Date.now() - createdAtMs) / 1000)) : null,
    upstreamSessionRefHash: row.upstream_session_ref ? await sha256Hex(row.upstream_session_ref) : null,
    upstreamSessionRefPrefix: row.upstream_session_ref?.slice(0, 16) ?? null,
    attestationId: input.attestationId ?? null,
    proofHash: input.proofHash ?? (proof ? await sha256Hex(proof) : null),
    proofLength: proof?.length ?? null,
    providerPayloadRefHash: providerPayloadRef ? await sha256Hex(providerPayloadRef) : null,
    providerPayloadRefLength: providerPayloadRef?.length ?? null,
  }
}

async function completeVerySession(
  client: Client,
  env: Env,
  row: VerificationSessionRow,
  input: VerificationCompletionInput,
): Promise<VerificationSession> {
  const nativePayload = parseVeryNativeCompletionPayload(input.providerPayloadRef)
  if (row.provider_mode === "native_sdk") {
    return completeVeryNativeSession(client, env, row, input, nativePayload)
  }
  if (nativePayload) {
    throw badRequestError("Very native SDK payload cannot complete a widget session")
  }

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
    const providerPayloadRef = typeof input.providerPayloadRef === "string"
      ? input.providerPayloadRef
      : typeof input.proof === "string"
        ? input.proof
        : null
    outcome = await provider.getSessionOutcome({
      upstreamSessionRef: row.upstream_session_ref,
      providerPayloadRef,
      expectedBinding: buildVerySessionBinding({
        verificationSessionId: input.verificationSessionId,
        challengeExpiresAt: row.expires_at ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    })
  } catch (error) {
    const details = providerErrorDetails(error)
    throw providerUnavailable(
      error instanceof Error ? error.message : "Very provider is unavailable",
      details,
    )
  }

  if (outcome.status === "verified") {
    logVerificationDebug(env, "[very-provider] completion outcome", {
      verificationSessionId: input.verificationSessionId,
      outcome: outcome.status,
    })
    return finalizeVerification(client, row, input, null, null, null, outcome.attestationData)
  }

  if (outcome.status === "pending") {
    logVerificationDebug(env, "[very-provider] completion outcome", {
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

async function completeVeryNativeSession(
  client: Client,
  env: Env,
  row: VerificationSessionRow,
  input: VerificationCompletionInput,
  nativePayload: { code: string } | null,
): Promise<VerificationSession> {
  if (!nativePayload) {
    throw badRequestError("Very native SDK completion requires a native SDK payload")
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

  const createdAtMs = Date.parse(row.created_at)
  if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > nativeAuthCodeTtlMs(env)) {
    throw eligibilityFailed("Very native SDK authorization code has expired")
  }

  let outcome: VerySessionOutcome
  try {
    const provider = getVeryProvider(env)
    if (!provider.getNativeSessionOutcome) {
      throw providerUnavailable("Very native SDK OAuth is not available")
    }
    outcome = await provider.getNativeSessionOutcome({
      authorizationCode: nativePayload.code,
      verificationSessionId: input.verificationSessionId,
      userId: input.userId,
    })
  } catch (error) {
    const details = providerErrorDetails(error)
    throw providerUnavailable(
      error instanceof Error ? error.message : "Very native SDK OAuth is unavailable",
      details,
    )
  }

  if (outcome.status === "verified") {
    logVerificationDebug(env, "[very-provider] native completion outcome", {
      verificationSessionId: input.verificationSessionId,
      outcome: outcome.status,
    })
    return finalizeVerification(client, row, input, null, null, null, outcome.attestationData)
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

async function completeSelfSession(
  client: Client,
  env: Env,
  row: VerificationSessionRow,
  input: VerificationCompletionInput,
): Promise<VerificationSession> {
  const sessionExpiresAt = row.expires_at
  if (sessionExpiresAt && new Date(sessionExpiresAt) < new Date()) {
    console.warn("[self-provider] completion outcome", {
      ...await selfCompletionDiagnostics(row, input),
      outcome: "expired",
      failureReason: "provider_expired",
    })
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
      attestationId: input.attestationId ?? null,
      proof: input.proof ?? null,
      providerPayloadRef: input.providerPayloadRef ?? null,
    })
  } catch (error) {
    console.warn("[self-provider] completion provider unavailable", {
      ...await selfCompletionDiagnostics(row, input),
      errorName: error instanceof Error ? error.name : null,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorDetails: providerErrorDetails(error),
    })
    throw providerUnavailable(
      error instanceof Error ? error.message : "Self provider is unavailable"
    )
  }

  if (outcome.status === "verified") {
    const requestedCapabilities = parseJsonField<RequestedVerificationCapability[]>(
      row.requested_capabilities_json,
      "verification_sessions.requested_capabilities_json",
    )
    const verificationRequirements = parseVerificationRequirements(row.verification_requirements_json)
    const missingClaims: string[] = []
    if (requestedCapabilities.includes("age_over_18") && outcome.claims.age_over_18 !== true) {
      missingClaims.push("age_over_18")
    }
    for (const requirement of verificationRequirements) {
      if (requirement.proof_type !== "minimum_age") {
        continue
      }
      const minimumAge = requirement.minimum_age
      if (
        typeof minimumAge === "number"
        && Number.isInteger(minimumAge)
        && (outcome.claims.minimum_age == null || outcome.claims.minimum_age < minimumAge)
      ) {
        missingClaims.push(`minimum_age:${minimumAge}`)
      }
    }
    if (requestedCapabilities.includes("nationality") && !outcome.claims.nationality) {
      missingClaims.push("nationality")
    }
    if (requestedCapabilities.includes("gender") && !outcome.claims.gender) {
      missingClaims.push("gender")
    }
    if (missingClaims.length > 0) {
      console.warn("[self-provider] completion outcome", {
        ...await selfCompletionDiagnostics(row, input),
        outcome: "failed",
        failureReason: `missing_required_claims:${missingClaims.join(",")}`,
        missingClaims,
        hasNationality: Boolean(outcome.claims.nationality),
        hasGender: Boolean(outcome.claims.gender),
        hasNullifier: Boolean(outcome.claims.nullifier),
        ageOver18: outcome.claims.age_over_18,
        minimumAge: outcome.claims.minimum_age ?? null,
      })
      const updatedAt = new Date().toISOString()
      await client.execute({
        sql: `UPDATE verification_sessions SET status = 'failed', failure_code = ?2, updated_at = ?3 WHERE verification_session_id = ?1`,
        args: [input.verificationSessionId, `missing_required_claims:${missingClaims.join(",")}`, updatedAt],
      })
      const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
      return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
    }
    console.info("[self-provider] completion outcome", {
      ...await selfCompletionDiagnostics(row, input),
      outcome: outcome.status,
      hasNationality: Boolean(outcome.claims.nationality),
      hasGender: Boolean(outcome.claims.gender),
      hasNullifier: Boolean(outcome.claims.nullifier),
      ageOver18: outcome.claims.age_over_18,
      minimumAge: outcome.claims.minimum_age ?? null,
    })
    return finalizeVerification(client, row, input, requestedCapabilities, verificationRequirements, outcome.claims)
  }

  if (outcome.status === "pending") {
    console.warn("[self-provider] completion outcome", {
      ...await selfCompletionDiagnostics(row, input),
      outcome: outcome.status,
    })
    return serializeVerificationSession({ row, attestationRows: [] })
  }

  if (outcome.status === "failed") {
    console.warn("[self-provider] completion outcome", {
      ...await selfCompletionDiagnostics(row, input),
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
    console.warn("[self-provider] completion outcome", {
      ...await selfCompletionDiagnostics(row, input),
      outcome: outcome.status,
      failureReason: "provider_expired",
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

type IdentityNullifierInput = {
  provider: "self" | "very"
  mechanism: "zk-nullifier" | "palm-nullifier"
  nullifierHash: string
}

function getRecordString(record: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function normalizeHashLike(value: string): string | null {
  const trimmed = value.trim()
  return /^[0-9a-f]{64}$/iu.test(trimmed) ? trimmed.toLowerCase() : null
}

async function resolveIdentityNullifier(input: {
  row: VerificationSessionRow
  selfClaims?: { nullifier?: string | null } | null
  attestationData?: Record<string, unknown>
}): Promise<IdentityNullifierInput> {
  if (input.row.provider === "self") {
    const nullifier = input.selfClaims?.nullifier?.trim() ?? ""
    if (!nullifier) {
      throw providerUnavailable("Self verification did not return a stable nullifier")
    }
    return {
      provider: "self",
      mechanism: "zk-nullifier",
      nullifierHash: normalizeHashLike(nullifier) ?? await sha256Hex(`self:zk-nullifier:${nullifier}`),
    }
  }

  if (input.row.provider === "very") {
    const raw = getRecordString(input.attestationData, ["nullifier_hash", "nullifierHash", "nullifier"])
    if (!raw) {
      throw providerUnavailable("Very verification did not return a stable nullifier")
    }
    return {
      provider: "very",
      mechanism: "palm-nullifier",
      nullifierHash: normalizeHashLike(raw) ?? await sha256Hex(`${VERY_UNIQUE_HUMAN_DOMAIN}:palm-nullifier:${raw}`),
    }
  }

  throw internalError("Unsupported identity nullifier provider")
}

async function finalizeVerification(
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
  selfClaims?: { age_over_18: boolean; minimum_age?: number | null; nationality: string | null; gender: "M" | "F" | null; nullifier?: string | null } | null,
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
  if (activeNullifierUserId && activeNullifierUserId !== input.userId) {
    throw eligibilityFailed("Identity proof is already linked to another user")
  }
  const attestationInserts: InStatement[] = []
  const uniqueHumanAttestationId = makeId("att")

  capabilities.unique_human = {
    state: "verified",
    provider: row.provider === "self" || row.provider === "very" ? row.provider : null,
    proof_type: "unique_human",
    mechanism: row.provider === "very" ? "very_provider" : "session_complete",
    verified_at: unixSeconds(updatedAt),
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
      verified_at: unixSeconds(updatedAt),
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
      verified_at: unixSeconds(updatedAt),
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
      verified_at: unixSeconds(updatedAt),
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
      verified_at: unixSeconds(updatedAt),
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
