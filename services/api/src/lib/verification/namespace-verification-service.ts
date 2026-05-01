import type { Client } from "../sql-client"
import { internalError, providerUnavailable } from "../errors"
import { makeId } from "../helpers"
import {
  serializeNamespaceVerification,
  serializeNamespaceVerificationSession,
} from "../auth/auth-serializers"
import {
  verifyHnsTxtRecord,
} from "./hns-verifier"
import type { HnsVerifyTxtResult } from "./hns-verifier"
import {
  verifySpacesFabricPublish,
} from "./spaces-verifier"
import type {
  Env,
  NamespaceVerification,
  NamespaceVerificationSession,
} from "../../types"
import {
  buildNamespaceSessionResponseContext,
  deriveAcceptedHnsSnapshot,
  deriveSpacesAcceptedSnapshot,
  getNamespaceVerificationRowForUser,
  getNamespaceVerificationSessionRowForUser,
  isHnsVerifierConfigured,
  makeNamespaceAssertionStatements,
  makeNamespaceCapabilityStatements,
  parseStoredSpacesChallenge,
} from "./verification-shared"
import { isDnsSetupRequiredNamespaceSessionRow } from "./namespace-verification-policy"
import { isTrustedHnsAuthorityObservation } from "./namespace-verification-policy"
import { restartNamespaceVerificationChallenge } from "./namespace-verification-restart"
import {
  HNS_VERIFIER_OBSERVATION_PROVIDER,
  resolveHnsObservationProviderFallback,
} from "./namespace-observation-provider"

export { startNamespaceVerificationSession } from "./namespace-verification-start"

function requireNormalizedRootLabel(row: Pick<NamespaceVerificationSession, "family" | "normalized_root_label">): string {
  const normalizedRootLabel = row.normalized_root_label?.trim()
  if (!normalizedRootLabel) {
    throw internalError(`${row.family} namespace verification session is missing normalized_root_label`)
  }
  return normalizedRootLabel
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
  },
): Promise<NamespaceVerificationSession | null> {
  const row = await getNamespaceVerificationSessionRowForUser(client, input.namespaceVerificationSessionId, input.userId)
  if (!row) {
    return null
  }

  const now = new Date()
  const updatedAt = now.toISOString()
  if (input.restartChallenge) {
    await restartNamespaceVerificationChallenge({
      client,
      env,
      row,
      namespaceVerificationSessionId: input.namespaceVerificationSessionId,
      now,
      updatedAt,
    })
    return getNamespaceVerificationSession(client, env, input.namespaceVerificationSessionId, input.userId)
  }

  if (isDnsSetupRequiredNamespaceSessionRow(row)) {
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
    const storedChallenge = parseStoredSpacesChallenge(row.challenge_payload_json)
    const verification = await verifySpacesFabricPublish(env, {
      rootLabel: storedChallenge.root_label,
      txtKey: storedChallenge.txt_key,
      txtValue: storedChallenge.txt_value,
      webUrl: storedChallenge.web_url,
      freedomUrl: storedChallenge.freedom_url,
    })
    if (!verification.fabricPublishVerified) {
      const challengeExpiresAtMs = row.challenge_expires_at ? Date.parse(row.challenge_expires_at) : Number.NaN
      const challengeStillValid = Number.isFinite(challengeExpiresAtMs) && challengeExpiresAtMs > now.getTime()
      const pendingReasons = new Set([
        "pirate_verify_record_missing",
        "web_target_missing",
        "freedom_target_missing",
      ])
      const isPending = challengeStillValid && pendingReasons.has(verification.failureReason ?? "")

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
          verification.observationProvider ?? row.observation_provider ?? "spaces_verifier",
          isPending ? null : (verification.failureReason ?? "fabric_publish_not_verified"),
          updatedAt,
        ],
      })
      return getNamespaceVerificationSession(client, env, input.namespaceVerificationSessionId, input.userId)
    }

    const observationProvider = verification.observationProvider ?? row.observation_provider ?? "spaces_verifier"
    const acceptedRootLabel = requireNormalizedRootLabel(row)
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
          INSERT INTO namespace_verifications (
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
          ON CONFLICT(namespace_verification_id) DO UPDATE SET
            source_namespace_verification_session_id = excluded.source_namespace_verification_session_id,
            user_id = excluded.user_id,
            family = excluded.family,
            normalized_root_label = excluded.normalized_root_label,
            status = excluded.status,
            root_exists = excluded.root_exists,
            root_control_verified = excluded.root_control_verified,
            expiry_horizon_sufficient = excluded.expiry_horizon_sufficient,
            routing_enabled = excluded.routing_enabled,
            pirate_dns_authority_verified = excluded.pirate_dns_authority_verified,
            club_attach_allowed = excluded.club_attach_allowed,
            pirate_web_routing_allowed = excluded.pirate_web_routing_allowed,
            pirate_subdomain_issuance_allowed = excluded.pirate_subdomain_issuance_allowed,
            control_class = excluded.control_class,
            operation_class = excluded.operation_class,
            observation_provider = excluded.observation_provider,
            evidence_bundle_ref = excluded.evidence_bundle_ref,
            accepted_at = excluded.accepted_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at,
            anchor_height = excluded.anchor_height,
            anchor_block_hash = excluded.anchor_block_hash,
            anchor_root_hash = excluded.anchor_root_hash,
            proof_root_hash = excluded.proof_root_hash
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
          ) VALUES (?1, ?2, ?3, 'spaces', ?4, 'fabric_publish', ?5, ?6, ?7, NULL, ?8, ?8, ?8)
        `,
        args: [
          evidenceBundleId,
          input.namespaceVerificationSessionId,
          verificationId,
          acceptedRootLabel,
          observationProvider,
          JSON.stringify([observationProvider]),
          JSON.stringify({ verification, challenge_payload: storedChallenge }),
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
          { name: "fabric_publish_verified", value: snapshot.fabricPublishVerified },
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
    let observationProvider = row.observation_provider ?? resolveHnsObservationProviderFallback(env)
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
        rootLabel: requireNormalizedRootLabel(row),
        challengeHost: row.challenge_host,
        challengeTxtValue: row.challenge_txt_value ?? "",
      })
      verificationResult = verification
      observationProvider = verification.observation_provider ?? HNS_VERIFIER_OBSERVATION_PROVIDER
      verificationEvidence = verification as Record<string, unknown>

      const trustedAuthorityObservation = isTrustedHnsAuthorityObservation(env, verification)
      if (verification.verified !== true || !trustedAuthorityObservation) {
        const challengeExpiresAtMs = row.challenge_expires_at ? Date.parse(row.challenge_expires_at) : Number.NaN
        const challengeStillValid = Number.isFinite(challengeExpiresAtMs) && challengeExpiresAtMs > now.getTime()
        const observedValues = verification.observed_values ?? []
        const isPending = challengeStillValid && (observedValues.length === 0 || !trustedAuthorityObservation)

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
            isPending
              ? (!trustedAuthorityObservation ? "dns_delegation_not_confirmed" : null)
              : (!trustedAuthorityObservation ? "dns_delegation_not_confirmed" : (verification.failure_reason ?? "challenge_mismatch")),
            updatedAt,
          ],
        })
        return getNamespaceVerificationSession(client, env, input.namespaceVerificationSessionId, input.userId)
      }
    } else {
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
          INSERT INTO namespace_verifications (
            namespace_verification_id, source_namespace_verification_session_id, user_id, family, normalized_root_label,
            status, root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
            pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
            control_class, operation_class, observation_provider, evidence_bundle_ref, accepted_at, expires_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'hns', ?4, 'verified', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17, ?18, ?17, ?17
          )
          ON CONFLICT(namespace_verification_id) DO UPDATE SET
            source_namespace_verification_session_id = excluded.source_namespace_verification_session_id,
            user_id = excluded.user_id,
            family = excluded.family,
            normalized_root_label = excluded.normalized_root_label,
            status = excluded.status,
            root_exists = excluded.root_exists,
            root_control_verified = excluded.root_control_verified,
            expiry_horizon_sufficient = excluded.expiry_horizon_sufficient,
            routing_enabled = excluded.routing_enabled,
            pirate_dns_authority_verified = excluded.pirate_dns_authority_verified,
            club_attach_allowed = excluded.club_attach_allowed,
            pirate_web_routing_allowed = excluded.pirate_web_routing_allowed,
            pirate_subdomain_issuance_allowed = excluded.pirate_subdomain_issuance_allowed,
            control_class = excluded.control_class,
            operation_class = excluded.operation_class,
            observation_provider = excluded.observation_provider,
            evidence_bundle_ref = excluded.evidence_bundle_ref,
            accepted_at = excluded.accepted_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `,
        args: [
          verificationId,
          input.namespaceVerificationSessionId,
          input.userId,
          requireNormalizedRootLabel(row),
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
          requireNormalizedRootLabel(row),
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
