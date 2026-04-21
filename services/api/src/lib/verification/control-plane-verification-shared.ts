import type { Client, InStatement } from "../sql-client"
import { executeFirst } from "../db-helpers"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import type {
  NamespaceVerificationRow,
  NamespaceVerificationSessionRow,
  UserAttestationRow,
  VerificationSessionRow,
} from "../auth/auth-db-rows"
import {
  toNamespaceVerificationRow,
  toNamespaceVerificationSessionRow,
  toUserAttestationRow,
  toVerificationSessionRow,
} from "../auth/auth-db-rows"
import {
  inspectHnsRoot,
  isHnsVerifierConfigured,
} from "./hns-verifier"
import type { HnsInspectResult, HnsVerifyTxtResult } from "./hns-verifier"
import type { SpacesChallengePayload } from "./spaces-verifier"
import type {
  Env,
  NamespaceVerificationSession,
} from "../../types"

function isProductionEnv(env: Env): boolean {
  return String(env.ENVIRONMENT || "").trim().toLowerCase() === "production"
}

export function isSpacesVerifierConfigured(env: Env): boolean {
  return String(env.SPACES_VERIFIER_BASE_URL || "").trim().length > 0
}

export function boolToDb(value: boolean | null | undefined): number | null {
  if (value == null) {
    return null
  }
  return value ? 1 : 0
}

export function getHnsChallengeTtlHours(env: Env): number {
  const rawTtlHours = Number(env.HNS_CHALLENGE_TTL_HOURS)
  if (Number.isFinite(rawTtlHours) && rawTtlHours >= 1 && rawTtlHours <= 168) {
    return rawTtlHours
  }
  return 24
}

export type HnsSessionAssertionSnapshot = {
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

export type NamespaceSessionResponseContext = {
  setupNameservers: string[] | null
}

type NamespaceVerificationClass =
  NonNullable<NamespaceVerificationSession["control_class"]>

type NamespaceVerificationOperationClass =
  NonNullable<NamespaceVerificationSession["operation_class"]>

export type SpacesAcceptedSnapshot = {
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

export function deriveHnsInspectionSnapshot(inspection: HnsInspectResult): HnsSessionAssertionSnapshot {
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

function getHnsSetupNameservers(value: { nameservers?: string[] | null }): string[] | null {
  const nameservers = value.nameservers?.map((entry) => entry.trim()).filter(Boolean) ?? []
  return nameservers.length > 0 ? nameservers : null
}

function parseStoredSetupNameservers(raw: string | null): string[] | null {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return null
    }

    const nameservers = parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)

    return nameservers.length > 0 ? nameservers : null
  } catch {
    return null
  }
}

function serializeSetupNameservers(value: string[] | null): string | null {
  return value && value.length > 0 ? JSON.stringify(value) : null
}

function shouldRequireHnsDnsSetup(
  env: Env,
  inspection: HnsInspectResult,
): boolean {
  if (!isHnsVerifierConfigured(env)) {
    return false
  }

  return inspection.pirate_dns_authority_verified !== true
}

export async function buildNamespaceSessionResponseContext(
  env: Env,
  row: NamespaceVerificationSessionRow,
): Promise<NamespaceSessionResponseContext> {
  const storedSetupNameservers = parseStoredSetupNameservers(row.setup_nameservers_json)
  if (storedSetupNameservers) {
    return { setupNameservers: storedSetupNameservers }
  }

  if (
    row.family !== "hns"
    || row.status !== "dns_setup_required"
    || !isHnsVerifierConfigured(env)
  ) {
    return { setupNameservers: null }
  }

  try {
    const inspection = await inspectHnsRoot(env, {
      rootLabel: row.normalized_root_label ?? row.submitted_root_label.toLowerCase(),
      challengeHost: row.challenge_host,
    })
    return {
      setupNameservers: getHnsSetupNameservers(inspection),
    }
  } catch {
    return { setupNameservers: null }
  }
}

export function deriveAcceptedHnsSnapshot(
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
    controlClass: verification?.control_class ?? row.control_class ?? null,
    operationClass: verification?.operation_class ?? row.operation_class ?? null,
  }
}

export function deriveSpacesAcceptedSnapshot(row: NamespaceVerificationSessionRow): SpacesAcceptedSnapshot {
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

export function parseStoredSpacesChallenge(
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

export function makeNamespaceAssertionStatements(input: {
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

export function makeNamespaceCapabilityStatements(input: {
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

export async function getVerificationSessionRowForUser(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<VerificationSessionRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT verification_session_id, user_id, provider, requested_capabilities_json, verification_requirements_json,
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

export async function getAttestationsBySourceSessionId(
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

export async function getNamespaceVerificationSessionRowForUser(
  client: Client,
  namespaceVerificationSessionId: string,
  userId: string,
): Promise<NamespaceVerificationSessionRow | null> {
  const row = await executeFirst(client, {
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
        nvs.setup_nameservers_json,
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

export async function getNamespaceVerificationRowForUser(
  client: Client,
  namespaceVerificationId: string,
  userId: string,
): Promise<NamespaceVerificationRow | null> {
  const row = await executeFirst(client, {
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

export {
  isHnsVerifierConfigured,
  isProductionEnv,
  serializeSetupNameservers,
  shouldRequireHnsDnsSetup,
}
