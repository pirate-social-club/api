import type { Client } from "../sql-client"
import { hasCheckConstraintName } from "../auth/auth-db-query-helpers"
import { internalError, providerUnavailable, verificationRequired } from "../errors"
import { makeId } from "../helpers"
import { getUserRow } from "../auth/auth-db-user-queries"
import {
  parseVerificationCapabilities,
  serializeNamespaceVerificationSession,
} from "../auth/auth-serializers"
import {
  assertHnsRootLabel,
  ensureHnsZone,
  inspectHnsRoot,
  isPlatformManagedHnsRoot,
  publishHnsTxtRecord,
} from "./hns-verifier"
import {
  inspectSpacesNamespace,
  mintSpacesChallenge,
  normalizeRootLabel,
} from "./spaces-verifier"
import type { Env, NamespaceVerificationSession } from "../../types"
import {
  buildNamespaceSessionResponseContext,
  deriveHnsInspectionSnapshot,
  getHnsChallengeTtlHours,
  getNamespaceVerificationSessionRowForUser,
  isHnsVerifierConfigured,
  isProductionEnv,
  isSpacesVerifierConfigured,
  serializeSetupNameservers,
  shouldRequireHnsDnsSetup,
  type HnsSessionAssertionSnapshot,
} from "./verification-shared"

async function insertNamespaceVerificationSessionWithLegacyStatusFallback(
  client: Client,
  statement: {
    sql: string
    args: unknown[]
    status: NamespaceVerificationSession["status"]
    failureReason: string | null
  },
): Promise<void> {
  try {
    await client.execute({
      sql: statement.sql,
      args: statement.args,
    })
    return
  } catch (error) {
    const shouldFallback = statement.status === "dns_setup_required"
      && hasCheckConstraintName(error, "namespace_verification_sessions_status_check")
    if (!shouldFallback) {
      throw error
    }
  }

  const fallbackArgs = [...statement.args]
  fallbackArgs[5] = "challenge_required"
  await client.execute({
    sql: statement.sql,
    args: fallbackArgs,
  })
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
  const normalizedRootLabel = input.family === "spaces"
    ? normalizeRootLabel(input.rootLabel)
    : input.rootLabel.trim().toLowerCase()
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
          ?1, NULL, ?2, 'spaces', ?3, ?4, 'challenge_required', 'fabric_txt_publish', ?5, ?6,
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
    assertHnsRootLabel(normalizedRootLabel)
    const challengeExpiresAt = new Date(now.getTime() + getHnsChallengeTtlHours(env) * 60 * 60 * 1000).toISOString()
    const challengeHost = `_pirate.${normalizedRootLabel}`
    const challengeTxtValue = `pirate-verification=${sessionId}`
    let status: NamespaceVerificationSession["status"] = "challenge_required"
    let challengeKind: NamespaceVerificationSession["challenge_kind"] = "dns_txt"
    let persistedChallengeHost: string | null = challengeHost
    let persistedChallengeTxtValue: string | null = challengeTxtValue
    let persistedSetupNameservers: string | null = null
    let persistedChallengeExpiresAt: string | null = challengeExpiresAt
    let failureReason: string | null = null
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
      let inspection = await inspectHnsRoot(env, {
        rootLabel: normalizedRootLabel,
        challengeHost,
      })
      if (
        shouldRequireHnsDnsSetup(env, inspection)
        && inspection.failure_reason === "zone_not_provisioned"
        && isPlatformManagedHnsRoot(normalizedRootLabel)
      ) {
        await ensureHnsZone(env, {
          rootLabel: normalizedRootLabel,
        })
        inspection = await inspectHnsRoot(env, {
          rootLabel: normalizedRootLabel,
          challengeHost,
        })
      }
      inspectionSnapshot = deriveHnsInspectionSnapshot(inspection)
      persistedSetupNameservers = serializeSetupNameservers(inspection.nameservers?.map((entry) => entry.trim()).filter(Boolean) ?? null)
      if (shouldRequireHnsDnsSetup(env, inspection)) {
        status = "dns_setup_required"
        challengeKind = null
        persistedChallengeHost = null
        persistedChallengeTxtValue = null
        persistedChallengeExpiresAt = null
        failureReason = inspection.failure_reason ?? "dns_setup_required"
        observationProvider = inspection.observation_provider ?? "hns_verifier"
      } else {
        const published = await publishHnsTxtRecord(env, {
          rootLabel: normalizedRootLabel,
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
        observationProvider = published.observation_provider ?? inspection.observation_provider ?? "hns_verifier"
      }
    } else if (isProductionEnv(env)) {
      throw providerUnavailable("HNS verifier is not configured")
    }

    const insertStatement = {
      sql: `
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
          normalized_root_label, status, challenge_kind, challenge_payload_json, challenge_host, challenge_txt_value, setup_nameservers_json, challenge_expires_at,
          root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
          pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
          pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
          evidence_bundle_ref, failure_reason, accepted_at, expires_at, created_at, updated_at
        ) VALUES (
          ?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10, ?11,
          ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
          NULL, ?23, NULL, ?24, ?25, ?25
        )
      `,
      args: [
        sessionId,
        input.userId,
        input.family,
        input.rootLabel,
        normalizedRootLabel,
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
        createdAt,
      ],
      status,
      failureReason,
    }
    await insertNamespaceVerificationSessionWithLegacyStatusFallback(client, insertStatement)
  }

  const row = await getNamespaceVerificationSessionRowForUser(client, sessionId, input.userId)
  if (!row) {
    throw internalError("Namespace verification session row is missing after creation")
  }
  const responseContext = await buildNamespaceSessionResponseContext(env, row)
  return serializeNamespaceVerificationSession(row, responseContext)
}
