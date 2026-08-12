import type { Client } from "../sql-client"
import type { NamespaceVerificationSessionRow } from "../auth/auth-db-rows"
import { conflictError, HttpError, providerUnavailable, verificationRequired } from "../errors"
import { makeId } from "../helpers"
import { withTransaction } from "../transactions"
import { prepareHnsImportChallenge } from "./hns-import-challenge"
import {
  acquireHnsImportRestartAttempt,
  completeHnsImportRestartAttempt,
  releaseHnsImportRestartAttempt,
  reserveHnsImportSessionLock,
} from "./hns-import-session-lock"
import {
  inspectSpacesNamespace,
  mintSpacesChallenge,
} from "./spaces-verifier"
import type { Env } from "../../env"
import type { NamespaceVerificationSession } from "../../types"
import {
  getHnsChallengeTtlHours,
  isProductionEnv,
  isSpacesVerifierConfigured,
} from "./verification-shared"

const RESTARTABLE_SESSION_STATUSES = new Set<NamespaceVerificationSession["status"]>([
  "challenge_required",
  "dns_setup_required",
  "expired",
  "failed",
])
const HNS_RESTART_ATTEMPT_TTL_MS = 10 * 60 * 1000

export async function restartNamespaceVerificationChallenge(input: {
  client: Client
  env: Env
  row: NamespaceVerificationSessionRow
  namespaceVerificationSessionId: string
  now: Date
  updatedAt: string
}): Promise<void> {
  if (!RESTARTABLE_SESSION_STATUSES.has(input.row.status)) {
    throw conflictError("Namespace verification session cannot be restarted from its current state", {
      status: input.row.status,
    })
  }

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
  const challengeHost = rootLabel
  const challengeExpiresAt = new Date(input.now.getTime() + getHnsChallengeTtlHours(input.env) * 60 * 60 * 1000).toISOString()
  const expiresAt = new Date(input.now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()

  await reserveHnsImportSessionLock(input.client, {
    normalizedRootLabel: rootLabel,
    sessionId: input.namespaceVerificationSessionId,
    userId: input.row.user_id,
    expiresAt: challengeExpiresAt,
    now: input.updatedAt,
  })
  const attempt = await acquireHnsImportRestartAttempt(input.client, {
    normalizedRootLabel: rootLabel,
    sessionId: input.namespaceVerificationSessionId,
    token: makeId("hra"),
    challengeTxtValue: `pirate-verification=${makeId("nch")}`,
    expiresAt: new Date(input.now.getTime() + HNS_RESTART_ATTEMPT_TTL_MS).toISOString(),
    now: input.updatedAt,
  })
  let prepared: Awaited<ReturnType<typeof prepareHnsImportChallenge>>
  try {
    prepared = await prepareHnsImportChallenge(input.env, {
      rootLabel,
      challengeTxtValue: attempt.challengeTxtValue,
    })
  } catch (error) {
    if (error instanceof HttpError && error.code === "verifier_contract_incompatible") {
      await releaseHnsImportRestartAttempt(input.client, {
        normalizedRootLabel: rootLabel,
        sessionId: input.namespaceVerificationSessionId,
        token: attempt.token,
      })
    }
    throw error
  }
  const snapshot = prepared.inspectionSnapshot

  await withTransaction(input.client, "write", async (tx) => {
    const result = await tx.execute({
      sql: `
      UPDATE namespace_verification_sessions
      SET namespace_verification_id = NULL,
          status = 'challenge_required',
          challenge_kind = 'hns_import',
          challenge_payload_json = ?2,
          challenge_host = ?3,
          challenge_txt_value = ?4,
          setup_nameservers_json = ?5,
          challenge_expires_at = ?6,
          root_exists = ?7,
          root_control_verified = ?8,
          expiry_horizon_sufficient = ?9,
          routing_enabled = ?10,
          pirate_dns_authority_verified = ?11,
          club_attach_allowed = ?12,
          pirate_web_routing_allowed = ?13,
          pirate_subdomain_issuance_allowed = ?14,
          control_class = ?15,
          operation_class = ?16,
          observation_provider = ?17,
          evidence_bundle_ref = NULL,
          failure_reason = NULL,
          accepted_at = NULL,
          anchor_height = ?18,
          anchor_block_hash = ?19,
          anchor_root_hash = NULL,
          proof_root_hash = NULL,
          expires_at = ?20,
          updated_at = ?21
      WHERE namespace_verification_session_id = ?1
        AND status IN ('challenge_required', 'dns_setup_required', 'expired', 'failed')
        AND EXISTS (
          SELECT 1
          FROM hns_import_session_locks
          WHERE normalized_root_label = ?22
            AND namespace_verification_session_id = ?1
            AND restart_attempt_token = ?23
        )
    `,
      args: [
        input.namespaceVerificationSessionId,
        JSON.stringify(prepared.challengePayload),
        challengeHost,
        attempt.challengeTxtValue,
        prepared.setupNameservers,
        challengeExpiresAt,
        snapshot.rootExists ?? null,
        snapshot.rootControlVerified ?? null,
        snapshot.expiryHorizonSufficient ?? null,
        snapshot.routingEnabled ?? null,
        snapshot.pirateDnsAuthorityVerified ?? null,
        snapshot.clubAttachAllowed ?? null,
        snapshot.pirateWebRoutingAllowed ?? null,
        snapshot.pirateSubdomainIssuanceAllowed ?? null,
        snapshot.controlClass ?? null,
        snapshot.operationClass ?? null,
        prepared.observationProvider,
        prepared.anchorHeight,
        prepared.anchorBlockHash,
        expiresAt,
        input.updatedAt,
        rootLabel,
        attempt.token,
      ],
    })
    if (result.rowsAffected !== 1) {
      throw conflictError("Handshake import restart lost its session state or lock")
    }
    await completeHnsImportRestartAttempt(tx, {
      normalizedRootLabel: rootLabel,
      sessionId: input.namespaceVerificationSessionId,
      token: attempt.token,
      sessionExpiresAt: challengeExpiresAt,
    })
  })
}
