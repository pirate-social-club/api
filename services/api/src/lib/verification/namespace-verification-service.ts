import type { Client } from "../sql-client"
import { HttpError, internalError, providerUnavailable } from "../errors"
import { makeId } from "../helpers"
import {
  serializeNamespaceVerification,
  serializeNamespaceVerificationSession,
} from "../auth/auth-serializers"
import {
  checkHnsAuthorityHealth,
  publishHnsChallenge,
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
  deriveAcceptedHnsSnapshot,
  deriveSpacesAcceptedSnapshot,
  getNamespaceVerificationRowForUser,
  getNamespaceVerificationSessionRowForUser,
  isHnsVerifierConfigured,
  makeNamespaceAssertionStatements,
  makeNamespaceCapabilityStatements,
  parseStoredSpacesChallenge,
} from "./verification-shared"
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
  namespaceVerificationSessionId: string,
  userId: string,
): Promise<NamespaceVerificationSession | null> {
  const row = await getNamespaceVerificationSessionRowForUser(client, namespaceVerificationSessionId, userId)
  if (!row) {
    return null
  }
  return serializeNamespaceVerificationSession(row)
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
      return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
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
      let verification: HnsVerifyTxtResult
      try {
        verification = await verifyHnsTxtRecord(env, {
          rootLabel: requireNormalizedRootLabel(row),
          challengeHost: row.challenge_host,
          challengeTxtValue: row.challenge_txt_value ?? "",
        })
      } catch (caught) {
        if (caught instanceof HttpError && caught.code === "provider_unavailable") {
          await client.execute({
            sql: `
              UPDATE namespace_verification_sessions
              SET status = 'challenge_pending',
                  failure_reason = 'provider_unavailable',
                  updated_at = ?2
              WHERE namespace_verification_session_id = ?1
            `,
            args: [input.namespaceVerificationSessionId, updatedAt],
          })
          return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
        }
        throw caught
      }
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
        return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
      }
    } else {
      throw providerUnavailable("HNS verifier is not configured")
    }

    // Assertion 3 (authority health), computed BEFORE the snapshot so routing
    // capabilities can be derived from it rather than assuming it. Only
    // meaningful on the Pirate-managed path; null for owner-managed sessions.
    let authorityHealthVerified: number | null = null
    let authorityProvisioningEvidence: Awaited<ReturnType<typeof publishHnsChallenge>> | null = null
    let authorityHealthEvidence: Awaited<ReturnType<typeof checkHnsAuthorityHealth>> | null = null
    const ownershipSnapshot = deriveAcceptedHnsSnapshot(row, verificationResult)
    if (ownershipSnapshot.pirateDnsAuthorityVerified === 1) {
      try {
        // Provision the child zone AND publish the session nonce in one write —
        // a bare ensure-zone would leave the health check nothing to read back.
        authorityProvisioningEvidence = await publishHnsChallenge(env, {
          rootLabel: requireNormalizedRootLabel(row),
          challengeHost: row.challenge_host,
          challengeTxtValue: row.challenge_txt_value ?? "",
        })
        try {
          const health = await checkHnsAuthorityHealth(env, {
            rootLabel: requireNormalizedRootLabel(row),
            challengeHost: row.challenge_host,
          })
          authorityHealthEvidence = health
          // A serving-path result is REQUIRED: challenge_served === null means
          // the check could not observe the zone being served, which is not
          // evidence of health.
          authorityHealthVerified = health.zone_provisioned === true
            && health.challenge_present === true
            && health.challenge_served === true
            ? 1
            : 0
        } catch {
          // Health is post-acceptance evidence; an unavailable health check
          // must not fail the session. Leave the assertion unknown (which
          // withholds the routing capabilities that depend on it).
          authorityHealthVerified = null
        }
      } catch (caught) {
        if (caught instanceof HttpError && caught.code === "provider_unavailable") {
          await client.execute({
            sql: `
              UPDATE namespace_verification_sessions
              SET status = 'challenge_pending',
                  failure_reason = 'provider_unavailable',
                  updated_at = ?2
              WHERE namespace_verification_session_id = ?1
            `,
            args: [input.namespaceVerificationSessionId, updatedAt],
          })
          return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
        }
        throw caught
      }
    }

    // Preserve every response that contributes to the accepted assertion set.
    // In particular, authority health must be auditable independently from the
    // ownership proof that preceded it.
    verificationEvidence = {
      ...verificationEvidence,
      authority_provisioning: authorityProvisioningEvidence,
      authority_health: authorityHealthEvidence,
    }
    const evidenceResolverPath = [
      observationProvider,
      authorityProvisioningEvidence?.observation_provider,
      authorityHealthEvidence?.observation_provider,
    ].filter((provider, index, providers): provider is string => (
      typeof provider === "string" && provider.length > 0 && providers.indexOf(provider) === index
    ))

    // Re-derive with health in hand so pirate_web_routing_allowed /
    // pirate_subdomain_issuance_allowed reflect assertion 3 instead of assuming
    // a healthy authority.
    const acceptedSnapshot = deriveAcceptedHnsSnapshot(row, verificationResult, authorityHealthVerified)

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
              ownership_source = ?16,
              authority_health_verified = ?17,
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
          verificationResult?.ownership_source ?? null,
          authorityHealthVerified,
        ],
      },
      {
        sql: `
          INSERT INTO namespace_verifications (
            namespace_verification_id, source_namespace_verification_session_id, user_id, family, normalized_root_label,
            status, root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
            pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
            control_class, operation_class, observation_provider, evidence_bundle_ref, accepted_at, expires_at, created_at, updated_at,
            ownership_source, authority_health_verified
          ) VALUES (
            ?1, ?2, ?3, 'hns', ?4, 'verified', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17, ?18, ?17, ?17,
            ?19, ?20
          )
          ON CONFLICT(namespace_verification_id) DO UPDATE SET
            ownership_source = excluded.ownership_source,
            authority_health_verified = excluded.authority_health_verified,
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
          verificationResult?.ownership_source ?? null,
          authorityHealthVerified,
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
          JSON.stringify(evidenceResolverPath),
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
          { name: "authority_health_verified", value: authorityHealthVerified },
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
