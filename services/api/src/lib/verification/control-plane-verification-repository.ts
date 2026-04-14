import { createClient } from "@libsql/client"
import type { Client, InStatement, InValue } from "@libsql/client"
import { badRequestError, eligibilityFailed, internalError, providerUnavailable, verificationRequired } from "../errors"
import { makeId } from "../helpers"
import {
  firstRow,
  getUserRow,
  requireControlPlaneDbUrl,
} from "../auth/control-plane-auth-queries"
import {
  parseVerificationCapabilities,
  serializeNamespaceVerification,
  serializeNamespaceVerificationSession,
  serializeVerificationSession,
} from "../auth/control-plane-auth-serializers"
import type {
  NamespaceVerificationRow,
  NamespaceVerificationSessionRow,
  UserAttestationRow,
  UserRow,
  VerificationSessionRow,
} from "../auth/control-plane-auth-rows"
import {
  toNamespaceVerificationRow,
  toNamespaceVerificationSessionRow,
  toUserAttestationRow,
  toVerificationSessionRow,
} from "../auth/control-plane-auth-rows"
import {
  inspectHnsRoot,
  isHnsVerifierConfigured,
  publishHnsTxtRecord,
  verifyHnsTxtRecord,
} from "./hns-verifier"
import type { HnsInspectResult, HnsVerifyTxtResult } from "./hns-verifier"
import type { VeryProvider, VerySessionOutcome } from "./very-provider"
import { getVeryProvider } from "./very-provider"
import type { SelfProvider, SelfSessionOutcome } from "./self-provider"
import { canonicalizeRequestedCapabilities, getSelfProvider } from "./self-provider"
import {
  inspectSpacesNamespace,
  mintSpacesChallenge,
  verifySpacesSignature,
} from "./spaces-verifier"
import type { SpacesChallengePayload } from "./spaces-verifier"
import type {
  Env,
  NamespaceVerification,
  NamespaceVerificationSession,
  RequestedVerificationCapability,
  VerificationIntent,
  VerificationSession,
  VerificationSessionLaunch,
} from "../../types"

function isProductionEnv(env: Env): boolean {
  return String(env.ENVIRONMENT || "").trim().toLowerCase() === "production"
}

function isSpacesVerifierConfigured(env: Env): boolean {
  return String(env.SPACES_VERIFIER_BASE_URL || "").trim().length > 0
}

function boolToDb(value: boolean | null | undefined): number | null {
  if (value == null) {
    return null
  }
  return value ? 1 : 0
}

function isSessionExpired(expiresAt: string | null): boolean {
  if (!expiresAt) {
    return false
  }
  return Date.parse(expiresAt) <= Date.now()
}

type HnsSessionAssertionSnapshot = {
  rootExists: number | null
  rootControlVerified: number | null
  expiryHorizonSufficient: number | null
  routingEnabled: number | null
  pirateDnsAuthorityVerified: number | null
  clubAttachAllowed: number | null
  pirateWebRoutingAllowed: number | null
  pirateSubdomainIssuanceAllowed: number | null
  controlClass: NamespaceVerificationSession["control_class"]
  operationClass: NamespaceVerificationSession["operation_class"]
}

type NamespaceVerificationClass =
  Exclude<NamespaceVerificationSession["control_class"], undefined>

type NamespaceVerificationOperationClass =
  Exclude<NamespaceVerificationSession["operation_class"], undefined>

type SpacesAcceptedSnapshot = {
  rootExists: number
  rootControlVerified: number
  liveSignatureVerified: number
  expiryHorizonSufficient: number | null
  routingEnabled: number | null
  pirateDnsAuthorityVerified: number
  clubAttachAllowed: number
  pirateWebRoutingAllowed: number
  pirateSubdomainIssuanceAllowed: number
  ownerSignedRecordUpdatesAllowed: number
  pirateSubspaceIssuanceAllowed: number
  controlClass: NamespaceVerificationClass | null
  operationClass: NamespaceVerificationOperationClass | null
}

function deriveHnsInspectionSnapshot(inspection: HnsInspectResult): HnsSessionAssertionSnapshot {
  const rootExists = boolToDb(inspection.root_exists) ?? (inspection.zone_exists === true ? 1 : null)
  const rootControlVerified = boolToDb(inspection.root_control_verified)
  const expiryHorizonSufficient = boolToDb(inspection.expiry_horizon_sufficient)
  const routingEnabled = boolToDb(inspection.routing_enabled)
  const pirateDnsAuthorityVerified = boolToDb(inspection.pirate_dns_authority_verified)

  return {
    rootExists,
    rootControlVerified,
    expiryHorizonSufficient,
    routingEnabled,
    pirateDnsAuthorityVerified,
    clubAttachAllowed: null,
    pirateWebRoutingAllowed: null,
    pirateSubdomainIssuanceAllowed: null,
    controlClass: inspection.control_class ?? null,
    operationClass: inspection.operation_class ?? null,
  }
}

function deriveAcceptedHnsSnapshot(
  row: NamespaceVerificationSessionRow,
  verification: HnsVerifyTxtResult | null,
): HnsSessionAssertionSnapshot {
  const hasAcceptedTxtProof = verification?.verified === true
  const isLocalStubAcceptance = verification == null && row.observation_provider === "local_stub"
  const rootExists =
    boolToDb(verification?.root_exists) ?? row.root_exists ?? (hasAcceptedTxtProof || isLocalStubAcceptance ? 1 : null)
  const rootControlVerified =
    boolToDb(verification?.root_control_verified)
      ?? row.root_control_verified
      ?? (hasAcceptedTxtProof || isLocalStubAcceptance ? 1 : null)
  const expiryHorizonSufficient =
    boolToDb(verification?.expiry_horizon_sufficient) ?? row.expiry_horizon_sufficient ?? (isLocalStubAcceptance ? 1 : null)
  const routingEnabled =
    boolToDb(verification?.routing_enabled) ?? row.routing_enabled ?? (isLocalStubAcceptance ? 1 : null)
  const pirateDnsAuthorityVerified = boolToDb(verification?.pirate_dns_authority_verified)
    ?? row.pirate_dns_authority_verified
    ?? (isLocalStubAcceptance ? 1 : null)

  const clubAttachAllowed = rootControlVerified === 1 && expiryHorizonSufficient === 1 ? 1 : 0
  const pirateWebRoutingAllowed = rootControlVerified === 1 && routingEnabled === 1 ? 1 : 0
  const pirateSubdomainIssuanceAllowed =
    rootControlVerified === 1 && expiryHorizonSufficient === 1 && pirateDnsAuthorityVerified === 1 ? 1 : 0

  return {
    rootExists,
    rootControlVerified,
    expiryHorizonSufficient,
    routingEnabled,
    pirateDnsAuthorityVerified,
    clubAttachAllowed,
    pirateWebRoutingAllowed,
    pirateSubdomainIssuanceAllowed,
    controlClass: verification?.control_class ?? row.control_class ?? "single_holder_root",
    operationClass: verification?.operation_class ?? row.operation_class ?? "owner_managed_namespace",
  }
}

function deriveSpacesAcceptedSnapshot(row: NamespaceVerificationSessionRow): SpacesAcceptedSnapshot {
  const rootControlVerified = row.root_control_verified === 1 ? 1 : 0
  const expiryHorizonSufficient = row.expiry_horizon_sufficient ?? null
  const routingEnabled = row.routing_enabled ?? null
  const operationClass = row.operation_class ?? null
  const ownerSignedRecordUpdatesAllowed =
    rootControlVerified === 1 && operationClass === "owner_signed_updates_namespace" ? 1 : 0

  return {
    rootExists: 1,
    rootControlVerified,
    liveSignatureVerified: 1,
    expiryHorizonSufficient,
    routingEnabled,
    pirateDnsAuthorityVerified: 0,
    clubAttachAllowed: rootControlVerified === 1 && expiryHorizonSufficient === 1 ? 1 : 0,
    pirateWebRoutingAllowed: rootControlVerified === 1 && routingEnabled === 1 ? 1 : 0,
    pirateSubdomainIssuanceAllowed: 0,
    ownerSignedRecordUpdatesAllowed,
    pirateSubspaceIssuanceAllowed: 0,
    controlClass: row.control_class ?? null,
    operationClass,
  }
}

function parseStoredSpacesChallenge(
  challengePayloadJson: string | null,
): SpacesChallengePayload {
  if (!challengePayloadJson) {
    throw internalError("session has no stored challenge payload")
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(challengePayloadJson) as Record<string, unknown>
  } catch {
    throw internalError("session challenge payload is malformed")
  }

  if (
    parsed.kind !== "schnorr_sign"
    || typeof parsed.digest !== "string"
    || typeof parsed.root_pubkey !== "string"
    || typeof parsed.nonce !== "string"
    || typeof parsed.root_label !== "string"
    || typeof parsed.domain !== "string"
    || typeof parsed.issued_at !== "string"
    || typeof parsed.expires_at !== "string"
    || typeof parsed.message !== "string"
  ) {
    throw internalError("session challenge payload is missing required fields")
  }

  return parsed as SpacesChallengePayload
}

function makeNamespaceAssertionStatements(input: {
  family: "hns" | "spaces"
  sessionId: string
  verificationId: string
  evidenceBundleId: string
  acceptedAt: string
  assertions: Array<{
    name:
      | "root_exists"
      | "root_control_verified"
      | "expiry_horizon_sufficient"
      | "routing_enabled"
      | "pirate_dns_authority_verified"
      | "root_key_proof_verified"
      | "live_signature_verified"
      | "anchor_fresh_enough"
      | "owner_signed_updates_verified"
    value: number | null
  }>
}): InStatement[] {
  const statements: InStatement[] = []

  for (const assertion of input.assertions) {
    statements.push({
      sql: `
        INSERT INTO namespace_verification_assertions (
          assertion_record_id, namespace_verification_session_id, namespace_verification_id, family, assertion_name,
          assertion_value, source_evidence_bundle_id, status, first_accepted_at, last_revalidated_at, created_at, updated_at
        ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 'accepted', ?7, ?7, ?7, ?7)
      `,
      args: [
        makeId("nva"),
        input.sessionId,
        input.family,
        assertion.name,
        assertion.value,
        input.evidenceBundleId,
        input.acceptedAt,
      ],
    })
    statements.push({
      sql: `
        INSERT INTO namespace_verification_assertions (
          assertion_record_id, namespace_verification_session_id, namespace_verification_id, family, assertion_name,
          assertion_value, source_evidence_bundle_id, status, first_accepted_at, last_revalidated_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'accepted', ?8, ?8, ?8, ?8)
      `,
      args: [
        makeId("nva"),
        input.sessionId,
        input.verificationId,
        input.family,
        assertion.name,
        assertion.value,
        input.evidenceBundleId,
        input.acceptedAt,
      ],
    })
  }

  return statements
}

function makeNamespaceCapabilityStatements(input: {
  family: "hns" | "spaces"
  sessionId: string
  verificationId: string
  evidenceBundleId: string
  acceptedAt: string
  capabilities: Array<{
    name:
      | "club_attach_allowed"
      | "pirate_web_routing_allowed"
      | "pirate_subdomain_issuance_allowed"
      | "owner_signed_record_updates_allowed"
      | "pirate_subspace_issuance_allowed"
    value: number | null
  }>
}): InStatement[] {
  const statements: InStatement[] = []

  for (const capability of input.capabilities) {
    statements.push({
      sql: `
        INSERT OR REPLACE INTO namespace_verification_capabilities (
          capability_record_id, namespace_verification_session_id, namespace_verification_id, family, capability_name,
          capability_value, source_evidence_bundle_id, status, first_accepted_at, last_revalidated_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'accepted', ?8, ?8, ?8, ?8)
      `,
      args: [
        `nvc_${input.verificationId}_${capability.name}_accepted`,
        input.sessionId,
        input.verificationId,
        input.family,
        capability.name,
        capability.value,
        input.evidenceBundleId,
        input.acceptedAt,
      ],
    })
  }

  return statements
}

async function getVerificationSessionRowForUser(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<VerificationSessionRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT verification_session_id, user_id, provider, requested_capabilities_json,
             status, upstream_session_ref, result_ref, failure_code,
             wallet_attachment_id, verification_intent, policy_id,
             completed_at, expires_at, created_at, updated_at
      FROM verification_sessions
      WHERE verification_session_id = ?1
        AND user_id = ?2
      LIMIT 1
    `,
    args: [verificationSessionId, userId],
  })

  return row ? toVerificationSessionRow(row) : null
}

async function getAttestationsBySourceSessionId(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<UserAttestationRow[]> {
  const result = await client.execute({
    sql: `
      SELECT user_attestation_id, capability_key, status, verified_at, expires_at
      FROM user_attestations
      WHERE source_verification_session_id = ?1
        AND user_id = ?2
      ORDER BY created_at ASC
    `,
    args: [verificationSessionId, userId],
  })

  return result.rows.map((row) => toUserAttestationRow(row))
}

async function getNamespaceVerificationSessionRowForUser(
  client: Client,
  namespaceVerificationSessionId: string,
  userId: string,
): Promise<NamespaceVerificationSessionRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT
        nvs.namespace_verification_session_id,
        nvs.namespace_verification_id,
        nvs.user_id,
        nvs.family,
        nvs.submitted_root_label,
        nvs.normalized_root_label,
        nvs.status,
        nvs.challenge_kind,
        nvs.challenge_payload_json,
        nvs.challenge_host,
        nvs.challenge_txt_value,
        nvs.challenge_expires_at,
        nvs.root_exists,
        nvs.root_control_verified,
        nvs.expiry_horizon_sufficient,
        nvs.routing_enabled,
        nvs.pirate_dns_authority_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nva.namespace_verification_id IS NULL
            AND nva.assertion_name = 'root_key_proof_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS root_key_proof_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nva.namespace_verification_id IS NULL
            AND nva.assertion_name = 'live_signature_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS live_signature_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nva.namespace_verification_id IS NULL
            AND nva.assertion_name = 'anchor_fresh_enough'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS anchor_fresh_enough,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nva.namespace_verification_id IS NULL
            AND nva.assertion_name = 'owner_signed_updates_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS owner_signed_updates_verified,
        nvs.club_attach_allowed,
        nvs.pirate_web_routing_allowed,
        nvs.pirate_subdomain_issuance_allowed,
        (
          SELECT capability_value
          FROM namespace_verification_capabilities AS nvc
          WHERE nvc.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nvc.namespace_verification_id IS NULL
            AND nvc.capability_name = 'owner_signed_record_updates_allowed'
            AND nvc.status = 'accepted'
          ORDER BY nvc.updated_at DESC
          LIMIT 1
        ) AS owner_signed_record_updates_allowed,
        (
          SELECT capability_value
          FROM namespace_verification_capabilities AS nvc
          WHERE nvc.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nvc.namespace_verification_id IS NULL
            AND nvc.capability_name = 'pirate_subspace_issuance_allowed'
            AND nvc.status = 'accepted'
          ORDER BY nvc.updated_at DESC
          LIMIT 1
        ) AS pirate_subspace_issuance_allowed,
        nvs.control_class,
        nvs.operation_class,
        nvs.observation_provider,
        nvs.evidence_bundle_ref,
        nvs.failure_reason,
        nvs.accepted_at,
        nvs.anchor_height,
        nvs.anchor_block_hash,
        nvs.anchor_root_hash,
        nvs.proof_root_hash,
        nvs.expires_at,
        nvs.created_at,
        nvs.updated_at
      FROM namespace_verification_sessions AS nvs
      WHERE nvs.namespace_verification_session_id = ?1
        AND nvs.user_id = ?2
      LIMIT 1
    `,
    args: [namespaceVerificationSessionId, userId],
  })

  return row ? toNamespaceVerificationSessionRow(row) : null
}

async function getNamespaceVerificationRowForUser(
  client: Client,
  namespaceVerificationId: string,
  userId: string,
): Promise<NamespaceVerificationRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT
        nv.namespace_verification_id,
        nv.user_id,
        nv.family,
        nv.normalized_root_label,
        nv.status,
        nv.root_exists,
        nv.root_control_verified,
        nv.expiry_horizon_sufficient,
        nv.routing_enabled,
        nv.pirate_dns_authority_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_id = nv.namespace_verification_id
            AND nva.assertion_name = 'root_key_proof_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS root_key_proof_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_id = nv.namespace_verification_id
            AND nva.assertion_name = 'live_signature_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS live_signature_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_id = nv.namespace_verification_id
            AND nva.assertion_name = 'anchor_fresh_enough'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS anchor_fresh_enough,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_id = nv.namespace_verification_id
            AND nva.assertion_name = 'owner_signed_updates_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS owner_signed_updates_verified,
        nv.club_attach_allowed,
        nv.pirate_web_routing_allowed,
        nv.pirate_subdomain_issuance_allowed,
        (
          SELECT capability_value
          FROM namespace_verification_capabilities AS nvc
          WHERE nvc.namespace_verification_id = nv.namespace_verification_id
            AND nvc.capability_name = 'owner_signed_record_updates_allowed'
            AND nvc.status = 'accepted'
          ORDER BY nvc.updated_at DESC
          LIMIT 1
        ) AS owner_signed_record_updates_allowed,
        (
          SELECT capability_value
          FROM namespace_verification_capabilities AS nvc
          WHERE nvc.namespace_verification_id = nv.namespace_verification_id
            AND nvc.capability_name = 'pirate_subspace_issuance_allowed'
            AND nvc.status = 'accepted'
          ORDER BY nvc.updated_at DESC
          LIMIT 1
        ) AS pirate_subspace_issuance_allowed,
        nv.control_class,
        nv.operation_class,
        nv.observation_provider,
        nv.evidence_bundle_ref,
        nv.accepted_at,
        nv.anchor_height,
        nv.anchor_block_hash,
        nv.anchor_root_hash,
        nv.proof_root_hash,
        nv.expires_at,
        nv.created_at,
        nv.updated_at
      FROM namespace_verifications AS nv
      WHERE nv.namespace_verification_id = ?1
        AND nv.user_id = ?2
      LIMIT 1
    `,
    args: [namespaceVerificationId, userId],
  })

  return row ? toNamespaceVerificationRow(row) : null
}

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
    return finalizeVerification(client, row, input, null, null, outcome.attestationData)
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
  selfClaims?: { age_over_18: boolean; nationality: string | null } | null,
  attestationData?: Record<string, unknown>,
): Promise<VerificationSession> {
  const existingAttestations = await getAttestationsBySourceSessionId(client, input.verificationSessionId, input.userId)
  if (existingAttestations.some((a) => a.status === "accepted")) {
    return getVerificationSession(client, input.verificationSessionId, input.userId) as Promise<VerificationSession>
  }

  const now = new Date()
  const updatedAt = now.toISOString()
  const attestationId = input.attestationId?.trim() || makeId("att")
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

export async function startNamespaceVerificationSession(
  client: Client,
  env: Env,
  input: {
    userId: string
    family: "hns" | "spaces"
    rootLabel: string
  },
): Promise<NamespaceVerificationSession> {
  const userRow = await getUserRow(client, input.userId)
  if (!userRow) {
    throw internalError("User row missing while starting namespace verification session")
  }
  const capabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  if (capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }

  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const normalizedRootLabel = input.rootLabel.trim().toLowerCase()
  const sessionId = makeId("nvs")
  if (input.family === "spaces") {
    if (!isSpacesVerifierConfigured(env)) {
      if (isProductionEnv(env)) {
        throw providerUnavailable("Spaces verifier is not configured")
      }
      throw verificationRequired("Spaces verifier is not available in this environment")
    }
    const inspection = await inspectSpacesNamespace(env, normalizedRootLabel)
    if (!inspection.rootExists) {
      throw verificationRequired("Spaces namespace root does not exist")
    }
    if (!inspection.rootPubkey) {
      throw verificationRequired("Spaces namespace root has no verifiable public key")
    }
    if (!inspection.rootKeyProofVerified) {
      throw verificationRequired("Spaces namespace root key proof was not verified")
    }
    const challenge = await mintSpacesChallenge(
      env,
      normalizedRootLabel,
      inspection.rootPubkey,
      sessionId,
    )

    await client.execute({
      sql: `
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
          normalized_root_label, status, challenge_kind, challenge_payload_json, challenge_expires_at,
          root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
          pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
          pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
          evidence_bundle_ref, failure_reason, accepted_at, anchor_height, anchor_block_hash, anchor_root_hash, proof_root_hash,
          expires_at, created_at, updated_at
        ) VALUES (
          ?1, NULL, ?2, 'spaces', ?3, ?4, 'challenge_required', 'schnorr_sign', ?5, ?6,
          1, ?7, ?8, NULL, NULL, NULL, NULL, NULL, ?9, ?10, ?11,
          NULL, NULL, NULL, ?12, ?13, ?14, ?15, ?16, ?17, ?17
        )
      `,
      args: [
        sessionId,
        input.userId,
        input.rootLabel,
        normalizedRootLabel,
        JSON.stringify(challenge.challengePayload),
        challenge.challengeExpiresAt,
        inspection.rootKeyProofVerified ? 1 : 0,
        inspection.anchorFreshEnough == null ? null : inspection.anchorFreshEnough ? 1 : 0,
        inspection.controlClass,
        inspection.operationClass,
        inspection.observationProvider,
        inspection.acceptedAnchorHeight,
        inspection.acceptedAnchorBlockHash,
        inspection.acceptedAnchorRootHash,
        inspection.proofRootHash,
        expiresAt,
        createdAt,
      ],
    })
  } else {
    const challengeExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    const challengeHost = `_pirate.${normalizedRootLabel}`
    const challengeTxtValue = `pirate-verification=${sessionId}`
    let observationProvider = "local_stub"
    let inspectionSnapshot: HnsSessionAssertionSnapshot = {
      rootExists: null,
      rootControlVerified: null,
      expiryHorizonSufficient: null,
      routingEnabled: null,
      pirateDnsAuthorityVerified: null,
      clubAttachAllowed: null,
      pirateWebRoutingAllowed: null,
      pirateSubdomainIssuanceAllowed: null,
      controlClass: null,
      operationClass: null,
    }

    if (isHnsVerifierConfigured(env)) {
      const inspection = await inspectHnsRoot(env, {
        rootLabel: normalizedRootLabel,
        challengeHost,
      })
      inspectionSnapshot = deriveHnsInspectionSnapshot(inspection)
      const published = await publishHnsTxtRecord(env, {
        rootLabel: normalizedRootLabel,
        challengeHost,
        challengeTxtValue,
      })
      observationProvider = published.observation_provider ?? inspection.observation_provider ?? "hns_verifier"
    } else if (isProductionEnv(env)) {
      throw providerUnavailable("HNS verifier is not configured")
    }

    await client.execute({
      sql: `
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
          normalized_root_label, status, challenge_kind, challenge_payload_json, challenge_host, challenge_txt_value, challenge_expires_at,
          root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
          pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
          pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
          evidence_bundle_ref, failure_reason, accepted_at, expires_at, created_at, updated_at
        ) VALUES (
          ?1, NULL, ?2, ?3, ?4, ?5, 'challenge_required', 'dns_txt', NULL, ?6, ?7, ?8,
          ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
          NULL, NULL, NULL, ?20, ?21, ?21
        )
      `,
      args: [
        sessionId,
        input.userId,
        input.family,
        input.rootLabel,
        normalizedRootLabel,
        challengeHost,
        challengeTxtValue,
        challengeExpiresAt,
        inspectionSnapshot.rootExists ?? null,
        inspectionSnapshot.rootControlVerified ?? null,
        inspectionSnapshot.expiryHorizonSufficient ?? null,
        inspectionSnapshot.routingEnabled ?? null,
        inspectionSnapshot.pirateDnsAuthorityVerified ?? null,
        inspectionSnapshot.clubAttachAllowed ?? null,
        inspectionSnapshot.pirateWebRoutingAllowed ?? null,
        inspectionSnapshot.pirateSubdomainIssuanceAllowed ?? null,
        inspectionSnapshot.controlClass ?? null,
        inspectionSnapshot.operationClass ?? null,
        observationProvider,
        expiresAt,
        createdAt,
      ],
    })
  }

  const row = await getNamespaceVerificationSessionRowForUser(client, sessionId, input.userId)
  if (!row) {
    throw internalError("Namespace verification session row is missing after creation")
  }
  return serializeNamespaceVerificationSession(row)
}

export async function getNamespaceVerificationSession(
  client: Client,
  namespaceVerificationSessionId: string,
  userId: string,
): Promise<NamespaceVerificationSession | null> {
  const row = await getNamespaceVerificationSessionRowForUser(client, namespaceVerificationSessionId, userId)
  return row ? serializeNamespaceVerificationSession(row) : null
}

export async function completeNamespaceVerificationSession(
  client: Client,
  env: Env,
  input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
    signaturePayload?: Record<string, unknown> | null
  },
): Promise<NamespaceVerificationSession | null> {
  const row = await getNamespaceVerificationSessionRowForUser(client, input.namespaceVerificationSessionId, input.userId)
  if (!row) {
    return null
  }

  const now = new Date()
  const updatedAt = now.toISOString()
  if (input.restartChallenge) {
    if (row.family === "spaces") {
      if (!isSpacesVerifierConfigured(env)) {
        if (isProductionEnv(env)) {
          throw providerUnavailable("Spaces verifier is not configured")
        }
        throw verificationRequired("Spaces verifier is not available in this environment")
      }
      const inspection = await inspectSpacesNamespace(env, row.normalized_root_label ?? row.submitted_root_label.toLowerCase())
      if (!inspection.rootExists) {
        throw verificationRequired("Spaces namespace root does not exist")
      }
      if (!inspection.rootPubkey) {
        throw verificationRequired("Spaces namespace root has no verifiable public key")
      }
      if (!inspection.rootKeyProofVerified) {
        throw verificationRequired("Spaces namespace root key proof was not verified")
      }
      const challenge = await mintSpacesChallenge(
        env,
        row.normalized_root_label ?? row.submitted_root_label.toLowerCase(),
        inspection.rootPubkey,
        input.namespaceVerificationSessionId,
      )
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
      await client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET namespace_verification_id = NULL,
              status = 'challenge_required',
              challenge_kind = 'schnorr_sign',
              challenge_payload_json = ?2,
              challenge_expires_at = ?3,
              root_exists = 1,
              root_control_verified = ?4,
              expiry_horizon_sufficient = ?5,
              control_class = ?6,
              operation_class = ?7,
              observation_provider = ?8,
              evidence_bundle_ref = NULL,
              failure_reason = NULL,
              accepted_at = NULL,
              anchor_height = ?9,
              anchor_block_hash = ?10,
              anchor_root_hash = ?11,
              proof_root_hash = ?12,
              expires_at = ?13,
              updated_at = ?14
          WHERE namespace_verification_session_id = ?1
        `,
        args: [
          input.namespaceVerificationSessionId,
          JSON.stringify(challenge.challengePayload),
          challenge.challengeExpiresAt,
          inspection.rootKeyProofVerified ? 1 : 0,
          inspection.anchorFreshEnough == null ? null : inspection.anchorFreshEnough ? 1 : 0,
          inspection.controlClass,
          inspection.operationClass,
          inspection.observationProvider,
          inspection.acceptedAnchorHeight,
          inspection.acceptedAnchorBlockHash,
          inspection.acceptedAnchorRootHash,
          inspection.proofRootHash,
          expiresAt,
          updatedAt,
        ],
      })
    } else {
      const challengeTxtValue = `pirate-verification=${makeId("nch")}`
      const challengeExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
      let observationProvider = row.observation_provider ?? "local_stub"
      let inspectionSnapshot: HnsSessionAssertionSnapshot = {
        rootExists: row.root_exists,
        rootControlVerified: row.root_control_verified ?? null,
        expiryHorizonSufficient: row.expiry_horizon_sufficient,
        routingEnabled: row.routing_enabled,
        pirateDnsAuthorityVerified: row.pirate_dns_authority_verified,
        clubAttachAllowed: null,
        pirateWebRoutingAllowed: null,
        pirateSubdomainIssuanceAllowed: null,
        controlClass: row.control_class,
        operationClass: row.operation_class,
      }

      if (isHnsVerifierConfigured(env)) {
        const inspection = await inspectHnsRoot(env, {
          rootLabel: row.normalized_root_label ?? row.submitted_root_label.toLowerCase(),
          challengeHost: row.challenge_host,
        })
        inspectionSnapshot = deriveHnsInspectionSnapshot(inspection)
        const published = await publishHnsTxtRecord(env, {
          rootLabel: row.normalized_root_label ?? row.submitted_root_label.toLowerCase(),
          challengeHost: row.challenge_host,
          challengeTxtValue,
        })
        observationProvider = published.observation_provider ?? "hns_verifier"
      } else if (isProductionEnv(env)) {
        throw providerUnavailable("HNS verifier is not configured")
      }

      await client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET namespace_verification_id = NULL,
              status = 'challenge_required',
              challenge_kind = 'dns_txt',
              challenge_payload_json = NULL,
              challenge_txt_value = ?2,
              challenge_expires_at = ?3,
              root_exists = ?4,
              root_control_verified = ?5,
              expiry_horizon_sufficient = ?6,
              routing_enabled = ?7,
              pirate_dns_authority_verified = ?8,
              club_attach_allowed = ?9,
              pirate_web_routing_allowed = ?10,
              pirate_subdomain_issuance_allowed = ?11,
              control_class = ?12,
              operation_class = ?13,
              observation_provider = ?14,
              evidence_bundle_ref = NULL,
              failure_reason = NULL,
              accepted_at = NULL,
              expires_at = ?15,
              updated_at = ?16
          WHERE namespace_verification_session_id = ?1
        `,
        args: [
          input.namespaceVerificationSessionId,
          challengeTxtValue,
          challengeExpiresAt,
          inspectionSnapshot.rootExists ?? null,
          inspectionSnapshot.rootControlVerified ?? null,
          inspectionSnapshot.expiryHorizonSufficient ?? null,
          inspectionSnapshot.routingEnabled ?? null,
          inspectionSnapshot.pirateDnsAuthorityVerified ?? null,
          inspectionSnapshot.clubAttachAllowed ?? null,
          inspectionSnapshot.pirateWebRoutingAllowed ?? null,
          inspectionSnapshot.pirateSubdomainIssuanceAllowed ?? null,
          inspectionSnapshot.controlClass ?? null,
          inspectionSnapshot.operationClass ?? null,
          observationProvider,
          expiresAt,
          updatedAt,
        ],
      })
    }
    return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
  }

  if (row.expires_at && new Date(row.expires_at).getTime() < now.getTime()) {
    await client.execute({
      sql: `
        UPDATE namespace_verification_sessions
        SET status = 'expired',
            failure_reason = 'session_expired',
            updated_at = ?2
        WHERE namespace_verification_session_id = ?1
      `,
      args: [input.namespaceVerificationSessionId, updatedAt],
    })
    return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
  }

  if (row.challenge_expires_at && new Date(row.challenge_expires_at).getTime() < now.getTime()) {
    await client.execute({
      sql: `
        UPDATE namespace_verification_sessions
        SET status = 'expired',
            failure_reason = 'challenge_expired',
            updated_at = ?2
        WHERE namespace_verification_session_id = ?1
      `,
      args: [input.namespaceVerificationSessionId, updatedAt],
    })
    return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
  }

  const verificationId = row.namespace_verification_id ?? makeId("nv")
  const evidenceBundleId = makeId("nev")
  const expiresAt = row.expires_at

  if (row.family === "spaces") {
    const signaturePayload = input.signaturePayload ?? null
    if (!signaturePayload || typeof signaturePayload !== "object") {
      throw badRequestError("signature_payload is required to complete a spaces namespace verification")
    }
    const storedChallenge = parseStoredSpacesChallenge(row.challenge_payload_json)
    const signature = typeof signaturePayload.signature === "string" ? signaturePayload.signature : null
    if (!signature) {
      throw badRequestError("signature_payload.signature is required")
    }
    const verification = await verifySpacesSignature(env, {
      digest: storedChallenge.digest,
      signature,
      rootPubkey: storedChallenge.root_pubkey,
      signerPubkey: typeof signaturePayload.signer_pubkey === "string" ? signaturePayload.signer_pubkey : null,
    })
    if (!verification.validSignature) {
      await client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET status = 'failed',
              observation_provider = ?2,
              failure_reason = ?3,
              updated_at = ?4
          WHERE namespace_verification_session_id = ?1
        `,
        args: [
          input.namespaceVerificationSessionId,
          verification.observationProvider ?? row.observation_provider ?? "spaces_verifier",
          verification.failureReason ?? (verification.wrongSigner ? "wrong_signer" : "invalid_signature"),
          updatedAt,
        ],
      })
      return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
    }

    const observationProvider = verification.observationProvider ?? row.observation_provider ?? "spaces_verifier"
    const acceptedRootLabel = row.normalized_root_label ?? row.submitted_root_label.toLowerCase()
    const snapshot = deriveSpacesAcceptedSnapshot(row)

    await client.batch([
      {
        sql: `
          UPDATE namespace_verification_sessions
          SET namespace_verification_id = ?2,
              status = 'verified',
              root_exists = ?4,
              root_control_verified = ?5,
              expiry_horizon_sufficient = ?6,
              routing_enabled = ?7,
              pirate_dns_authority_verified = ?8,
              club_attach_allowed = ?9,
              pirate_web_routing_allowed = ?10,
              pirate_subdomain_issuance_allowed = ?11,
              control_class = COALESCE(?12, 'single_holder_root'),
              operation_class = COALESCE(?13, 'owner_managed_namespace'),
              observation_provider = ?14,
              evidence_bundle_ref = ?3,
              failure_reason = NULL,
              accepted_at = ?15,
              updated_at = ?15
          WHERE namespace_verification_session_id = ?1
        `,
        args: [
          input.namespaceVerificationSessionId,
          verificationId,
          evidenceBundleId,
          snapshot.rootExists,
          snapshot.rootControlVerified,
          snapshot.expiryHorizonSufficient,
          snapshot.routingEnabled,
          snapshot.pirateDnsAuthorityVerified,
          snapshot.clubAttachAllowed,
          snapshot.pirateWebRoutingAllowed,
          snapshot.pirateSubdomainIssuanceAllowed,
          snapshot.controlClass,
          snapshot.operationClass,
          observationProvider,
          updatedAt,
        ],
      },
      {
        sql: `
          INSERT OR REPLACE INTO namespace_verifications (
            namespace_verification_id, source_namespace_verification_session_id, user_id, family, normalized_root_label,
            status, root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
            pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
            control_class, operation_class, observation_provider, evidence_bundle_ref, accepted_at, expires_at, created_at, updated_at,
            anchor_height, anchor_block_hash, anchor_root_hash, proof_root_hash
          ) VALUES (
            ?1, ?2, ?3, 'spaces', ?4, 'verified', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
            COALESCE(?13, 'single_holder_root'), COALESCE(?14, 'owner_managed_namespace'), ?15, ?16, ?17, ?18, ?17, ?17,
            ?19, ?20, ?21, ?22
          )
        `,
        args: [
          verificationId,
          input.namespaceVerificationSessionId,
          input.userId,
          acceptedRootLabel,
          snapshot.rootExists,
          snapshot.rootControlVerified,
          snapshot.expiryHorizonSufficient,
          snapshot.routingEnabled,
          snapshot.pirateDnsAuthorityVerified,
          snapshot.clubAttachAllowed,
          snapshot.pirateWebRoutingAllowed,
          snapshot.pirateSubdomainIssuanceAllowed,
          snapshot.controlClass,
          snapshot.operationClass,
          observationProvider,
          evidenceBundleId,
          updatedAt,
          expiresAt,
          row.anchor_height ?? null,
          row.anchor_block_hash ?? null,
          row.anchor_root_hash ?? null,
          row.proof_root_hash ?? null,
        ],
      },
      {
        sql: `
          INSERT INTO namespace_verification_evidence_bundles (
            evidence_bundle_id, namespace_verification_session_id, namespace_verification_id, family, normalized_root_label,
            evidence_kind, provider, resolver_path_json, raw_response_json, evidence_hash, observed_at, created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'spaces', ?4, 'challenge_signature', ?5, ?6, ?7, NULL, ?8, ?8, ?8)
        `,
        args: [
          evidenceBundleId,
          input.namespaceVerificationSessionId,
          verificationId,
          acceptedRootLabel,
          observationProvider,
          JSON.stringify([observationProvider]),
          JSON.stringify({ verification, challenge_payload: storedChallenge, signature_payload: signaturePayload }),
          updatedAt,
        ],
      },
      ...makeNamespaceAssertionStatements({
        family: "spaces",
        sessionId: input.namespaceVerificationSessionId,
        verificationId,
        evidenceBundleId,
        acceptedAt: updatedAt,
        assertions: [
          { name: "root_exists", value: snapshot.rootExists },
          { name: "root_control_verified", value: snapshot.rootControlVerified },
          { name: "expiry_horizon_sufficient", value: snapshot.expiryHorizonSufficient },
          { name: "routing_enabled", value: snapshot.routingEnabled },
          { name: "pirate_dns_authority_verified", value: snapshot.pirateDnsAuthorityVerified },
          { name: "root_key_proof_verified", value: snapshot.rootControlVerified },
          { name: "live_signature_verified", value: snapshot.liveSignatureVerified },
          { name: "anchor_fresh_enough", value: snapshot.expiryHorizonSufficient },
          {
            name: "owner_signed_updates_verified",
            value: snapshot.ownerSignedRecordUpdatesAllowed,
          },
        ],
      }),
      ...makeNamespaceCapabilityStatements({
        family: "spaces",
        sessionId: input.namespaceVerificationSessionId,
        verificationId,
        evidenceBundleId,
        acceptedAt: updatedAt,
        capabilities: [
          { name: "club_attach_allowed", value: snapshot.clubAttachAllowed },
          { name: "pirate_web_routing_allowed", value: snapshot.pirateWebRoutingAllowed },
          { name: "pirate_subdomain_issuance_allowed", value: snapshot.pirateSubdomainIssuanceAllowed },
          { name: "owner_signed_record_updates_allowed", value: snapshot.ownerSignedRecordUpdatesAllowed },
          { name: "pirate_subspace_issuance_allowed", value: snapshot.pirateSubspaceIssuanceAllowed },
        ],
      }),
    ], "write")
  } else {
    let observationProvider = row.observation_provider ?? "local_stub"
    let verificationEvidence: Record<string, unknown> = {
      root_exists: row.root_exists === 1,
      root_control_verified: row.root_control_verified === 1,
      expiry_horizon_sufficient: row.expiry_horizon_sufficient === 1,
      routing_enabled: row.routing_enabled === 1,
      pirate_dns_authority_verified: row.pirate_dns_authority_verified === 1,
    }
    let verificationResult: HnsVerifyTxtResult | null = null

    if (isHnsVerifierConfigured(env)) {
      const verification = await verifyHnsTxtRecord(env, {
        rootLabel: row.normalized_root_label ?? row.submitted_root_label.toLowerCase(),
        challengeHost: row.challenge_host,
        challengeTxtValue: row.challenge_txt_value ?? "",
      })
      verificationResult = verification
      observationProvider = verification.observation_provider ?? "hns_verifier"
      verificationEvidence = verification as Record<string, unknown>

      if (verification.verified !== true) {
        await client.execute({
          sql: `
            UPDATE namespace_verification_sessions
            SET status = 'failed',
                observation_provider = ?2,
                failure_reason = ?3,
                updated_at = ?4
            WHERE namespace_verification_session_id = ?1
          `,
          args: [
            input.namespaceVerificationSessionId,
            observationProvider,
            verification.failure_reason ?? "challenge_mismatch",
            updatedAt,
          ],
        })
        return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
      }
    } else if (isProductionEnv(env)) {
      throw providerUnavailable("HNS verifier is not configured")
    }

    const acceptedSnapshot = deriveAcceptedHnsSnapshot(row, verificationResult)
    await client.batch([
      {
        sql: `
          UPDATE namespace_verification_sessions
          SET namespace_verification_id = ?2,
              status = 'verified',
              root_exists = ?4,
              root_control_verified = ?5,
              expiry_horizon_sufficient = ?6,
              routing_enabled = ?7,
              pirate_dns_authority_verified = ?8,
              club_attach_allowed = ?9,
              pirate_web_routing_allowed = ?10,
              pirate_subdomain_issuance_allowed = ?11,
              control_class = ?12,
              operation_class = ?13,
              observation_provider = ?14,
              evidence_bundle_ref = ?3,
              failure_reason = NULL,
              accepted_at = ?15,
              updated_at = ?15
          WHERE namespace_verification_session_id = ?1
        `,
        args: [
          input.namespaceVerificationSessionId,
          verificationId,
          evidenceBundleId,
          acceptedSnapshot.rootExists ?? null,
          acceptedSnapshot.rootControlVerified ?? null,
          acceptedSnapshot.expiryHorizonSufficient ?? null,
          acceptedSnapshot.routingEnabled ?? null,
          acceptedSnapshot.pirateDnsAuthorityVerified ?? null,
          acceptedSnapshot.clubAttachAllowed ?? null,
          acceptedSnapshot.pirateWebRoutingAllowed ?? null,
          acceptedSnapshot.pirateSubdomainIssuanceAllowed ?? null,
          acceptedSnapshot.controlClass ?? null,
          acceptedSnapshot.operationClass ?? null,
          observationProvider,
          updatedAt,
        ],
      },
      {
        sql: `
          INSERT OR REPLACE INTO namespace_verifications (
            namespace_verification_id, source_namespace_verification_session_id, user_id, family, normalized_root_label,
            status, root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
            pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
            control_class, operation_class, observation_provider, evidence_bundle_ref, accepted_at, expires_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'hns', ?4, 'verified', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17, ?18, ?17, ?17
          )
        `,
        args: [
          verificationId,
          input.namespaceVerificationSessionId,
          input.userId,
          row.normalized_root_label ?? row.submitted_root_label.toLowerCase(),
          acceptedSnapshot.rootExists ?? null,
          acceptedSnapshot.rootControlVerified ?? null,
          acceptedSnapshot.expiryHorizonSufficient ?? null,
          acceptedSnapshot.routingEnabled ?? null,
          acceptedSnapshot.pirateDnsAuthorityVerified ?? null,
          acceptedSnapshot.clubAttachAllowed ?? null,
          acceptedSnapshot.pirateWebRoutingAllowed ?? null,
          acceptedSnapshot.pirateSubdomainIssuanceAllowed ?? null,
          acceptedSnapshot.controlClass ?? null,
          acceptedSnapshot.operationClass ?? null,
          observationProvider,
          evidenceBundleId,
          updatedAt,
          expiresAt,
        ],
      },
      {
        sql: `
          INSERT INTO namespace_verification_evidence_bundles (
            evidence_bundle_id, namespace_verification_session_id, namespace_verification_id, family, normalized_root_label,
            evidence_kind, provider, resolver_path_json, raw_response_json, evidence_hash, observed_at, created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'hns', ?4, 'accepted_snapshot', ?5, ?6, ?7, NULL, ?8, ?8, ?8)
        `,
        args: [
          evidenceBundleId,
          input.namespaceVerificationSessionId,
          verificationId,
          row.normalized_root_label ?? row.submitted_root_label.toLowerCase(),
          observationProvider,
          JSON.stringify([observationProvider]),
          JSON.stringify(verificationEvidence),
          updatedAt,
        ],
      },
      ...makeNamespaceAssertionStatements({
        family: "hns",
        sessionId: input.namespaceVerificationSessionId,
        verificationId,
        evidenceBundleId,
        acceptedAt: updatedAt,
        assertions: [
          { name: "root_exists", value: acceptedSnapshot.rootExists },
          { name: "root_control_verified", value: acceptedSnapshot.rootControlVerified },
          { name: "expiry_horizon_sufficient", value: acceptedSnapshot.expiryHorizonSufficient },
          { name: "routing_enabled", value: acceptedSnapshot.routingEnabled },
          { name: "pirate_dns_authority_verified", value: acceptedSnapshot.pirateDnsAuthorityVerified },
        ],
      }),
      ...makeNamespaceCapabilityStatements({
        family: "hns",
        sessionId: input.namespaceVerificationSessionId,
        verificationId,
        evidenceBundleId,
        acceptedAt: updatedAt,
        capabilities: [
          { name: "club_attach_allowed", value: acceptedSnapshot.clubAttachAllowed },
          { name: "pirate_web_routing_allowed", value: acceptedSnapshot.pirateWebRoutingAllowed },
          { name: "pirate_subdomain_issuance_allowed", value: acceptedSnapshot.pirateSubdomainIssuanceAllowed },
          {
            name: "owner_signed_record_updates_allowed",
            value:
              acceptedSnapshot.rootControlVerified === 1
                && acceptedSnapshot.operationClass === "owner_signed_updates_namespace"
                ? 1
                : 0,
          },
          { name: "pirate_subspace_issuance_allowed", value: 0 },
        ],
      }),
    ], "write")
  }

  return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
}

export async function getNamespaceVerification(
  client: Client,
  namespaceVerificationId: string,
  userId: string,
): Promise<NamespaceVerification | null> {
  const row = await getNamespaceVerificationRowForUser(client, namespaceVerificationId, userId)
  return row ? serializeNamespaceVerification(row) : null
}

export interface VerificationRepository {
  startVerificationSession(input: {
    userId: string
    provider: "self" | "very"
    requestedCapabilities?: RequestedVerificationCapability[] | null
    walletAttachmentId?: string | null
    verificationIntent?: VerificationIntent | null
    policyId?: string | null
  }): Promise<VerificationSession>
  getVerificationSession(verificationSessionId: string, userId: string): Promise<VerificationSession | null>
  completeVerificationSession(input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: string | null
    proofHash?: string | null
    providerPayloadRef?: string | null
  }): Promise<VerificationSession | null>
  startNamespaceVerificationSession(input: {
    userId: string
    family: "hns" | "spaces"
    rootLabel: string
  }): Promise<NamespaceVerificationSession>
  getNamespaceVerificationSession(
    namespaceVerificationSessionId: string,
    userId: string,
  ): Promise<NamespaceVerificationSession | null>
  completeNamespaceVerificationSession(input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
    signaturePayload?: Record<string, unknown> | null
  }): Promise<NamespaceVerificationSession | null>
  getNamespaceVerification(namespaceVerificationId: string, userId: string): Promise<NamespaceVerification | null>
}

export class ControlPlaneVerificationRepository implements VerificationRepository {
  constructor(
    private readonly client: Client,
    private readonly env: Env,
  ) {}

  async startVerificationSession(input: {
    userId: string
    provider: "self" | "very"
    requestedCapabilities?: RequestedVerificationCapability[] | null
    walletAttachmentId?: string | null
    verificationIntent?: VerificationIntent | null
    policyId?: string | null
  }): Promise<VerificationSession> {
    return startVerificationSession(this.client, this.env, input)
  }

  async getVerificationSession(verificationSessionId: string, userId: string): Promise<VerificationSession | null> {
    return getVerificationSession(this.client, verificationSessionId, userId)
  }

  async completeVerificationSession(input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: string | null
    proofHash?: string | null
    providerPayloadRef?: string | null
  }): Promise<VerificationSession | null> {
    return completeVerificationSession(this.client, this.env, input)
  }

  async startNamespaceVerificationSession(input: {
    userId: string
    family: "hns" | "spaces"
    rootLabel: string
  }): Promise<NamespaceVerificationSession> {
    return startNamespaceVerificationSession(this.client, this.env, input)
  }

  async getNamespaceVerificationSession(
    namespaceVerificationSessionId: string,
    userId: string,
  ): Promise<NamespaceVerificationSession | null> {
    return getNamespaceVerificationSession(this.client, namespaceVerificationSessionId, userId)
  }

  async completeNamespaceVerificationSession(input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
    signaturePayload?: Record<string, unknown> | null
  }): Promise<NamespaceVerificationSession | null> {
    return completeNamespaceVerificationSession(this.client, this.env, input)
  }

  async getNamespaceVerification(namespaceVerificationId: string, userId: string): Promise<NamespaceVerification | null> {
    return getNamespaceVerification(this.client, namespaceVerificationId, userId)
  }
}

const globalScope = globalThis as typeof globalThis & {
  __pirateControlPlaneVerificationRepository?: ControlPlaneVerificationRepository
  __pirateControlPlaneVerificationRepositoryKey?: string
}

export function getControlPlaneVerificationRepository(env: Env): ControlPlaneVerificationRepository {
  const url = requireControlPlaneDbUrl(env)
  const authToken = String(env.TURSO_CONTROL_PLANE_AUTH_TOKEN || "").trim()
  const cacheKey = [
    url,
    authToken,
    String(env.VERY_API_URL || ""),
    String(env.VERY_API_KEY || ""),
    String(env.VERY_APP_ID || ""),
    String(env.HNS_VERIFIER_BASE_URL || ""),
    String(env.HNS_VERIFIER_AUTH_TOKEN || ""),
    String(env.ENVIRONMENT || ""),
  ].join("|")

  if (
    globalScope.__pirateControlPlaneVerificationRepository
    && globalScope.__pirateControlPlaneVerificationRepositoryKey === cacheKey
  ) {
    return globalScope.__pirateControlPlaneVerificationRepository
  }

  const repository = new ControlPlaneVerificationRepository(
    createClient({
      url,
      authToken: authToken || undefined,
    }),
    env,
  )
  globalScope.__pirateControlPlaneVerificationRepository = repository
  globalScope.__pirateControlPlaneVerificationRepositoryKey = cacheKey
  return repository
}
