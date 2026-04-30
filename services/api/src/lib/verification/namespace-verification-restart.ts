import type { Client } from "../sql-client"
import type { NamespaceVerificationSessionRow } from "../auth/auth-db-rows"
import { providerUnavailable, verificationRequired } from "../errors"
import { makeId } from "../helpers"
import {
  ensureHnsZone,
  inspectHnsRoot,
  publishHnsTxtRecord,
  shouldAutoProvisionHnsRoot,
} from "./hns-verifier"
import {
  inspectSpacesNamespace,
  mintSpacesChallenge,
} from "./spaces-verifier"
import type { Env } from "../../env"
import type { NamespaceVerificationSession } from "../../types"
import {
  HNS_VERIFIER_OBSERVATION_PROVIDER,
  resolveHnsObservationProviderFallback,
} from "./namespace-observation-provider"
import {
  deriveHnsInspectionSnapshot,
  getHnsChallengeTtlHours,
  isHnsVerifierConfigured,
  isProductionEnv,
  isSpacesVerifierConfigured,
  serializeSetupNameservers,
  shouldRequireHnsDnsSetup,
  type HnsSessionAssertionSnapshot,
} from "./verification-shared"

export async function restartNamespaceVerificationChallenge(input: {
  client: Client
  env: Env
  row: NamespaceVerificationSessionRow
  namespaceVerificationSessionId: string
  now: Date
  updatedAt: string
}): Promise<void> {
  if (input.row.family === "spaces") {
    await restartSpacesChallenge(input)
    return
  }

  await restartHnsChallenge(input)
}

async function restartSpacesChallenge(input: {
  client: Client
  env: Env
  row: NamespaceVerificationSessionRow
  namespaceVerificationSessionId: string
  now: Date
  updatedAt: string
}): Promise<void> {
  if (!isSpacesVerifierConfigured(input.env)) {
    if (isProductionEnv(input.env)) {
      throw providerUnavailable("Spaces verifier is not configured")
    }
    throw verificationRequired("Spaces verifier is not available in this environment")
  }
  const rootLabel = input.row.normalized_root_label ?? input.row.submitted_root_label.toLowerCase()
  const inspection = await inspectSpacesNamespace(input.env, rootLabel)
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
    input.env,
    rootLabel,
    inspection.rootPubkey,
    input.namespaceVerificationSessionId,
  )
  const expiresAt = new Date(input.now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  await input.client.execute({
    sql: `
      UPDATE namespace_verification_sessions
      SET namespace_verification_id = NULL,
          status = 'challenge_required',
          challenge_kind = 'fabric_txt_publish',
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
      input.updatedAt,
    ],
  })
}

async function restartHnsChallenge(input: {
  client: Client
  env: Env
  row: NamespaceVerificationSessionRow
  namespaceVerificationSessionId: string
  now: Date
  updatedAt: string
}): Promise<void> {
  const rootLabel = input.row.normalized_root_label ?? input.row.submitted_root_label.toLowerCase()
  const challengeHost = input.row.challenge_host ?? `_pirate.${rootLabel}`
  const challengeTxtValue = `pirate-verification=${makeId("nch")}`
  const challengeExpiresAt = new Date(input.now.getTime() + getHnsChallengeTtlHours(input.env) * 60 * 60 * 1000).toISOString()
  const expiresAt = new Date(input.now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  let status: NamespaceVerificationSession["status"] = "challenge_required"
  let challengeKind: NamespaceVerificationSession["challenge_kind"] = "dns_txt"
  let persistedChallengeHost: string | null = challengeHost
  let persistedChallengeTxtValue: string | null = challengeTxtValue
  let persistedSetupNameservers: string | null = input.row.setup_nameservers_json
  let persistedChallengeExpiresAt: string | null = challengeExpiresAt
  let failureReason: string | null = null
  let observationProvider = input.row.observation_provider ?? resolveHnsObservationProviderFallback(input.env)
  let inspectionSnapshot: HnsSessionAssertionSnapshot = {
    rootExists: input.row.root_exists,
    rootControlVerified: input.row.root_control_verified ?? null,
    expiryHorizonSufficient: input.row.expiry_horizon_sufficient,
    routingEnabled: input.row.routing_enabled,
    pirateDnsAuthorityVerified: input.row.pirate_dns_authority_verified,
    clubAttachAllowed: null,
    pirateWebRoutingAllowed: null,
    pirateSubdomainIssuanceAllowed: null,
    controlClass: input.row.control_class,
    operationClass: input.row.operation_class,
  }

  if (isHnsVerifierConfigured(input.env)) {
    let inspection = await inspectHnsRoot(input.env, {
      rootLabel,
      challengeHost,
    })
    if (
      shouldRequireHnsDnsSetup(input.env, inspection)
      && inspection.failure_reason === "zone_not_provisioned"
      && shouldAutoProvisionHnsRoot(input.env, rootLabel)
    ) {
      await ensureHnsZone(input.env, {
        rootLabel,
      })
      inspection = await inspectHnsRoot(input.env, {
        rootLabel,
        challengeHost,
      })
    }
    inspectionSnapshot = deriveHnsInspectionSnapshot(inspection)
    persistedSetupNameservers = serializeSetupNameservers(inspection.nameservers?.map((entry) => entry.trim()).filter(Boolean) ?? null)
    if (shouldRequireHnsDnsSetup(input.env, inspection)) {
      status = "dns_setup_required"
      challengeKind = null
      persistedChallengeHost = null
      persistedChallengeTxtValue = null
      persistedChallengeExpiresAt = null
      failureReason = inspection.failure_reason ?? "dns_setup_required"
      observationProvider = inspection.observation_provider ?? HNS_VERIFIER_OBSERVATION_PROVIDER
    } else {
      const published = await publishHnsTxtRecord(input.env, {
        rootLabel,
        challengeHost,
        challengeTxtValue,
      })
      persistedSetupNameservers =
        persistedSetupNameservers
        ?? serializeSetupNameservers(published.nameservers?.map((entry) => entry.trim()).filter(Boolean) ?? null)
      inspectionSnapshot.rootExists = inspectionSnapshot.rootExists ?? 1
      inspectionSnapshot.routingEnabled = inspectionSnapshot.routingEnabled ?? 1
      inspectionSnapshot.pirateDnsAuthorityVerified = 1
      inspectionSnapshot.operationClass = inspectionSnapshot.operationClass ?? "pirate_delegated_namespace"
      observationProvider = published.observation_provider ?? HNS_VERIFIER_OBSERVATION_PROVIDER
    }
  } else {
    throw providerUnavailable("HNS verifier is not configured")
  }

  await input.client.execute({
    sql: `
      UPDATE namespace_verification_sessions
      SET namespace_verification_id = NULL,
          status = ?2,
          challenge_kind = ?3,
          challenge_payload_json = NULL,
          challenge_host = ?4,
          challenge_txt_value = ?5,
          setup_nameservers_json = ?6,
          challenge_expires_at = ?7,
          root_exists = ?8,
          root_control_verified = ?9,
          expiry_horizon_sufficient = ?10,
          routing_enabled = ?11,
          pirate_dns_authority_verified = ?12,
          club_attach_allowed = ?13,
          pirate_web_routing_allowed = ?14,
          pirate_subdomain_issuance_allowed = ?15,
          control_class = ?16,
          operation_class = ?17,
          observation_provider = ?18,
          evidence_bundle_ref = NULL,
          failure_reason = ?19,
          accepted_at = NULL,
          expires_at = ?20,
          updated_at = ?21
      WHERE namespace_verification_session_id = ?1
    `,
    args: [
      input.namespaceVerificationSessionId,
      status,
      challengeKind,
      persistedChallengeHost,
      persistedChallengeTxtValue,
      persistedSetupNameservers,
      persistedChallengeExpiresAt,
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
      failureReason,
      expiresAt,
      input.updatedAt,
    ],
  })
}
