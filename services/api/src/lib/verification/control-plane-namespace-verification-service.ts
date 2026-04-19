import type { Client } from "../sql-client"
import { badRequestError, internalError, providerUnavailable, verificationRequired } from "../errors"
import { makeId } from "../helpers"
import {
  getUserRow,
} from "../auth/auth-db-queries"
import {
  parseVerificationCapabilities,
  serializeNamespaceVerification,
  serializeNamespaceVerificationSession,
} from "../auth/auth-serializers"
import {
  inspectHnsRoot,
  publishHnsTxtRecord,
  verifyHnsTxtRecord,
} from "./hns-verifier"
import type { HnsVerifyTxtResult } from "./hns-verifier"
import {
  inspectSpacesNamespace,
  mintSpacesChallenge,
  verifySpacesSignature,
} from "./spaces-verifier"
import type {
  Env,
  NamespaceVerification,
  NamespaceVerificationSession,
} from "../../types"
import {
  buildNamespaceSessionResponseContext,
  deriveAcceptedHnsSnapshot,
  deriveHnsInspectionSnapshot,
  deriveSpacesAcceptedSnapshot,
  getHnsChallengeTtlHours,
  getNamespaceVerificationRowForUser,
  getNamespaceVerificationSessionRowForUser,
  isHnsVerifierConfigured,
  isProductionEnv,
  isSpacesVerifierConfigured,
  makeNamespaceAssertionStatements,
  makeNamespaceCapabilityStatements,
  parseStoredSpacesChallenge,
  serializeSetupNameservers,
  shouldRequireHnsDnsSetup,
  type HnsSessionAssertionSnapshot,
} from "./control-plane-verification-shared"

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
      const inspection = await inspectHnsRoot(env, {
        rootLabel: normalizedRootLabel,
        challengeHost,
      })
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

    await client.execute({
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
    })
  }

  const row = await getNamespaceVerificationSessionRowForUser(client, sessionId, input.userId)
  if (!row) {
    throw internalError("Namespace verification session row is missing after creation")
  }
  const responseContext = await buildNamespaceSessionResponseContext(env, row)
  return serializeNamespaceVerificationSession(row, responseContext)
}

export async function getNamespaceVerificationSession(
  client: Client,
  env: Env,
  namespaceVerificationSessionId: string,
  userId: string,
): Promise<NamespaceVerificationSession | null> {
  const row = await getNamespaceVerificationSessionRowForUser(client, namespaceVerificationSessionId, userId)
  if (!row) {
    return null
  }
  const responseContext = await buildNamespaceSessionResponseContext(env, row)
  return serializeNamespaceVerificationSession(row, responseContext)
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
      const challengeHost = row.challenge_host ?? `_pirate.${row.normalized_root_label ?? row.submitted_root_label.toLowerCase()}`
      const challengeTxtValue = `pirate-verification=${makeId("nch")}`
      const challengeExpiresAt = new Date(now.getTime() + getHnsChallengeTtlHours(env) * 60 * 60 * 1000).toISOString()
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
      let status: NamespaceVerificationSession["status"] = "challenge_required"
      let challengeKind: NamespaceVerificationSession["challenge_kind"] = "dns_txt"
      let persistedChallengeHost: string | null = challengeHost
      let persistedChallengeTxtValue: string | null = challengeTxtValue
      let persistedSetupNameservers: string | null = row.setup_nameservers_json
      let persistedChallengeExpiresAt: string | null = challengeExpiresAt
      let failureReason: string | null = null
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
          challengeHost,
        })
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
            rootLabel: row.normalized_root_label ?? row.submitted_root_label.toLowerCase(),
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
          observationProvider = published.observation_provider ?? "hns_verifier"
        }
      } else if (isProductionEnv(env)) {
        throw providerUnavailable("HNS verifier is not configured")
      }

      await client.execute({
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
          updatedAt,
        ],
      })
    }
    return getNamespaceVerificationSession(client, env, input.namespaceVerificationSessionId, input.userId)
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
    return getNamespaceVerificationSession(client, env, input.namespaceVerificationSessionId, input.userId)
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
    return getNamespaceVerificationSession(client, env, input.namespaceVerificationSessionId, input.userId)
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
      return getNamespaceVerificationSession(client, env, input.namespaceVerificationSessionId, input.userId)
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
        const challengeExpiresAtMs = row.challenge_expires_at ? Date.parse(row.challenge_expires_at) : Number.NaN
        const challengeStillValid = Number.isFinite(challengeExpiresAtMs) && challengeExpiresAtMs > now.getTime()
        const observedValues = verification.observed_values ?? []
        const isPending = challengeStillValid && observedValues.length === 0

        await client.execute({
          sql: `
            UPDATE namespace_verification_sessions
            SET status = ?2,
                observation_provider = ?3,
                failure_reason = ?4,
                updated_at = ?5
            WHERE namespace_verification_session_id = ?1
          `,
          args: [
            input.namespaceVerificationSessionId,
            isPending ? "challenge_pending" : "failed",
            observationProvider,
            isPending ? null : (verification.failure_reason ?? "challenge_mismatch"),
            updatedAt,
          ],
        })
        return getNamespaceVerificationSession(client, env, input.namespaceVerificationSessionId, input.userId)
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

  return getNamespaceVerificationSession(client, env, input.namespaceVerificationSessionId, input.userId)
}

export async function getNamespaceVerification(
  client: Client,
  namespaceVerificationId: string,
  userId: string,
): Promise<NamespaceVerification | null> {
  const row = await getNamespaceVerificationRowForUser(client, namespaceVerificationId, userId)
  return row ? serializeNamespaceVerification(row) : null
}
