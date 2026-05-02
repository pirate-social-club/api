import type { InStatement } from "../sql-client"
import { internalError } from "../errors"
import { isProductionEnv, makeId } from "../helpers"
import type { NamespaceVerificationSessionRow } from "../auth/auth-db-rows"
import type { HnsInspectResult, HnsVerifyTxtResult } from "./hns-verifier"
import type { SpacesChallengePayload } from "./spaces-verifier"
import type { Env } from "../../env"
import type { NamespaceVerificationSession } from "../../types"
import { isLocalDevHnsObservationProvider } from "./namespace-observation-provider"

export { isHnsVerifierConfigured } from "./hns-verifier"
export { isProductionEnv }

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

type NamespaceVerificationClass =
  NonNullable<NamespaceVerificationSession["control_class"]>

type NamespaceVerificationOperationClass =
  NonNullable<NamespaceVerificationSession["operation_class"]>

export type SpacesAcceptedSnapshot = {
  rootExists: number
  rootControlVerified: number
  fabricPublishVerified: number
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

export function serializeSetupNameservers(value: string[] | null): string | null {
  return value && value.length > 0 ? JSON.stringify(value) : null
}

export function isTrustedHnsAuthorityObservation(
  env: Env,
  verification: Pick<HnsVerifyTxtResult, "observation_provider">,
): boolean {
  if (!isProductionEnv(env)) {
    return true
  }

  return typeof verification.observation_provider === "string"
    && TRUSTED_HNS_OBSERVATION_PROVIDERS.has(verification.observation_provider)
}

const TRUSTED_HNS_OBSERVATION_PROVIDERS = new Set([
  "hns_parent_chain",
  "hns_public_dns",
  "web3dns_json_doh",
  "web3dns_public_dns",
])

export function deriveAcceptedHnsSnapshot(
  row: NamespaceVerificationSessionRow,
  verification: HnsVerifyTxtResult | null,
): HnsSessionAssertionSnapshot {
  const hasAcceptedTxtProof = verification?.verified === true
  const isLocalDevAcceptance = verification == null && isLocalDevHnsObservationProvider(row.observation_provider)
  const rootExists =
    boolToDb(verification?.root_exists) ?? row.root_exists ?? (hasAcceptedTxtProof || isLocalDevAcceptance ? 1 : null)
  const rootControlVerified =
    boolToDb(verification?.root_control_verified)
      ?? row.root_control_verified
      ?? (hasAcceptedTxtProof || isLocalDevAcceptance ? 1 : null)
  const expiryHorizonSufficient =
    boolToDb(verification?.expiry_horizon_sufficient) ?? row.expiry_horizon_sufficient ?? (isLocalDevAcceptance ? 1 : null)
  const routingEnabled =
    boolToDb(verification?.routing_enabled) ?? row.routing_enabled ?? (isLocalDevAcceptance ? 1 : null)
  const pirateDnsAuthorityVerified = boolToDb(verification?.pirate_dns_authority_verified)
    ?? row.pirate_dns_authority_verified
    ?? (isLocalDevAcceptance ? 1 : null)

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
  const routingEnabled = 1
  const operationClass = row.operation_class ?? null
  const ownerSignedRecordUpdatesAllowed =
    rootControlVerified === 1 && operationClass === "owner_signed_updates_namespace" ? 1 : 0

  return {
    rootExists: 1,
    rootControlVerified,
    fabricPublishVerified: 1,
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
    parsed.kind !== "fabric_txt_publish"
    || typeof parsed.root_pubkey !== "string"
    || typeof parsed.nonce !== "string"
    || typeof parsed.root_label !== "string"
    || typeof parsed.domain !== "string"
    || typeof parsed.issued_at !== "string"
    || typeof parsed.expires_at !== "string"
    || parsed.txt_key !== "pirate-verify"
    || typeof parsed.txt_value !== "string"
    || typeof parsed.web_url !== "string"
    || typeof parsed.freedom_url !== "string"
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
      | "fabric_publish_verified"
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
        INSERT INTO namespace_verification_capabilities (
          capability_record_id, namespace_verification_session_id, namespace_verification_id, family, capability_name,
          capability_value, source_evidence_bundle_id, status, first_accepted_at, last_revalidated_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'accepted', ?8, ?8, ?8, ?8)
        ON CONFLICT(capability_record_id) DO UPDATE SET
          namespace_verification_session_id = excluded.namespace_verification_session_id,
          namespace_verification_id = excluded.namespace_verification_id,
          family = excluded.family,
          capability_name = excluded.capability_name,
          capability_value = excluded.capability_value,
          source_evidence_bundle_id = excluded.source_evidence_bundle_id,
          status = excluded.status,
          first_accepted_at = excluded.first_accepted_at,
          last_revalidated_at = excluded.last_revalidated_at,
          updated_at = excluded.updated_at
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
