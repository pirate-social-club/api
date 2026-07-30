import { createHmac } from "node:crypto"

import type { Env } from "../../env"
import { openCommunityWriteClient } from "../communities/community-read-access"
import { getCommunityRepository } from "../communities/db-community-repository"
import { executeFirst } from "../db-helpers"
import { conflictError, internalError, notFoundError, providerUnavailable } from "../errors"
import { getControlPlaneClient } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import {
  assertIdempotentDanceAttemptTerminalFacts,
  type DanceAttemptTerminalFacts,
} from "./attempt-contract"

const PROVISIONAL_CALIBRATION_VERSION = "dance_calibration_gate0_provisional_v1"
const FINGERPRINT_RETENTION_MS = 90 * 24 * 60 * 60_000

type Session = {
  sessionId: string
  attemptId: string
  subjectUserId: string
  communityId: string
  songPostId: string
  bundleId: string
  revisionId: string
  activityDate: string
  activityTimezone: string
  status: string
  resultDigest: string | null
  referenceContentSha256: string
  referenceFeatureSha256: string
  poseModelVersion: string
  poseModelSha256: string
  featureSchemaVersion: string
  scorerVersion: string
  artifactVersion: string
  calibrationVersion: string
  calibrationChecksum: string
  fingerprintPolicyVersion: string
  integrityPolicyVersion: string
}

function required(row: unknown, field: string): string {
  const value = stringOrNull(rowValue(row, field))
  if (!value) throw internalError(`Dance attempt session is missing ${field}`)
  return value
}

function toSession(row: unknown): Session {
  return {
    sessionId: required(row, "dance_attempt_session_id"),
    attemptId: required(row, "dance_attempt_id"),
    subjectUserId: required(row, "subject_user_id"),
    communityId: required(row, "community_id"),
    songPostId: required(row, "referenced_song_post_id"),
    bundleId: required(row, "song_artifact_bundle_id"),
    revisionId: required(row, "dance_choreography_revision_id"),
    activityDate: required(row, "activity_date"),
    activityTimezone: required(row, "activity_timezone"),
    status: required(row, "status"),
    resultDigest: stringOrNull(rowValue(row, "grader_result_digest")),
    referenceContentSha256: required(row, "reference_content_sha256"),
    referenceFeatureSha256: required(row, "reference_feature_sha256"),
    poseModelVersion: required(row, "pose_model_version"),
    poseModelSha256: required(row, "pose_model_sha256"),
    featureSchemaVersion: required(row, "feature_schema_version"),
    scorerVersion: required(row, "scorer_version"),
    artifactVersion: required(row, "artifact_version"),
    calibrationVersion: required(row, "required_calibration_version"),
    calibrationChecksum: required(row, "required_calibration_checksum"),
    fingerprintPolicyVersion: required(row, "required_fingerprint_policy_version"),
    integrityPolicyVersion: required(row, "required_integrity_policy_version"),
  }
}

async function loadSession(client: Client, sessionId: string): Promise<Session> {
  const row = await executeFirst(client, {
    sql: "SELECT * FROM dance_attempt_sessions WHERE dance_attempt_session_id = ?1",
    args: [sessionId],
  })
  if (!row) throw notFoundError("Dance attempt session not found")
  return toSession(row)
}

function factsVersions(facts: DanceAttemptTerminalFacts) {
  return "versions" in facts ? facts.versions : null
}

function hasVersionMismatch(session: Session, facts: DanceAttemptTerminalFacts): boolean {
  const versions = factsVersions(facts)
  return Boolean(versions && (
    versions.scorer !== session.scorerVersion
    || versions.featureSchema !== session.featureSchemaVersion
    || versions.calibration !== session.calibrationVersion
    || versions.calibrationChecksum !== session.calibrationChecksum
    || versions.fingerprint !== session.fingerprintPolicyVersion
    || versions.poseModel !== session.poseModelVersion
    || versions.poseModelSha256 !== session.poseModelSha256
    || versions.referenceArtifact !== requiredArtifactVersion(session)
    || versions.referenceFeatureSha256 !== session.referenceFeatureSha256
  ))
}

function requiredArtifactVersion(session: Session): string {
  return session.artifactVersion
}

function fingerprintKey(env: Env): string {
  const key = String(env.DANCE_ATTEMPT_FINGERPRINT_HMAC_KEY ?? "")
  if (Buffer.byteLength(key) < 32) {
    throw providerUnavailable("Dance fingerprint authentication is not configured")
  }
  return key
}

function fingerprintHmac(env: Env, materialHex: string): string {
  return createHmac("sha256", fingerprintKey(env))
    .update(Buffer.from(materialHex, "hex"))
    .digest("hex")
}

type TerminalProjection = {
  status: "passed" | "rejected" | "failed"
  controlStatus: "finalized" | "rejected" | "failed"
  outcome: "scored" | "rejected" | "failed"
  reason: string | null
  scoreBps: number | null
  rankEligible: number
  qualityOutcome: "passed" | "rejected" | "failed"
  integrityOutcome: "passed" | "reference_replay" | "duplicate_attempt" | "unavailable"
  fingerprint: string | null
  calibrationAdmitted: number
}

async function projectTerminal(input: {
  env: Env
  controlClient: Client
  session: Session
  facts: DanceAttemptTerminalFacts
  now: string
}): Promise<TerminalProjection> {
  if (hasVersionMismatch(input.session, input.facts)) {
    return {
      status: "rejected",
      controlStatus: "rejected",
      outcome: "rejected",
      reason: "version_mismatch",
      scoreBps: null,
      rankEligible: 0,
      qualityOutcome: "rejected",
      integrityOutcome: "unavailable",
      fingerprint: null,
      calibrationAdmitted: 0,
    }
  }
  if (input.facts.outcome === "failed") {
    return {
      status: "failed",
      controlStatus: "failed",
      outcome: "failed",
      reason: input.facts.reason,
      scoreBps: null,
      rankEligible: 0,
      qualityOutcome: "failed",
      integrityOutcome: "unavailable",
      fingerprint: null,
      calibrationAdmitted: 0,
    }
  }
  if (input.facts.outcome === "rejected") {
    const replay = input.facts.reason === "reference_replay"
    return {
      status: "rejected",
      controlStatus: "rejected",
      outcome: "rejected",
      reason: input.facts.reason,
      scoreBps: null,
      rankEligible: 0,
      qualityOutcome: "rejected",
      integrityOutcome: replay ? "reference_replay" : "unavailable",
      fingerprint: null,
      calibrationAdmitted:
        "calibrationAdmitted" in input.facts && input.facts.calibrationAdmitted ? 1 : 0,
    }
  }

  const fingerprint = fingerprintHmac(
    input.env,
    input.facts.canonicalFingerprintMaterialHex,
  )
  const duplicate = await executeFirst(input.controlClient, {
    sql: `
      SELECT dance_attempt_id
      FROM dance_attempt_fingerprints
      WHERE subject_user_id = ?1
        AND dance_choreography_revision_id = ?2
        AND fingerprint_policy_version = ?3
        AND whole_attempt_hmac_sha256 = ?4
        AND expires_at > ?5
        AND dance_attempt_id <> ?6
      LIMIT 1
    `,
    args: [
      input.session.subjectUserId,
      input.session.revisionId,
      input.session.fingerprintPolicyVersion,
      fingerprint,
      input.now,
      input.session.attemptId,
    ],
  })
  if (duplicate) {
    return {
      status: "rejected",
      controlStatus: "rejected",
      outcome: "rejected",
      reason: "duplicate_attempt",
      scoreBps: null,
      rankEligible: 0,
      qualityOutcome: "passed",
      integrityOutcome: "duplicate_attempt",
      fingerprint,
      calibrationAdmitted: input.facts.calibrationAdmitted ? 1 : 0,
    }
  }
  // Gate-0 calibration is deliberately unadmitted. The API, not the grader,
  // owns rank eligibility; a signed callback cannot promote provisional scores.
  const calibrationAdmitted = input.session.calibrationVersion
      !== PROVISIONAL_CALIBRATION_VERSION
    && input.facts.calibrationAdmitted
    ? 1
    : 0
  return {
    status: "passed",
    controlStatus: "finalized",
    outcome: "scored",
    reason: null,
    scoreBps: input.facts.scoreBps,
    rankEligible: calibrationAdmitted,
    qualityOutcome: "passed",
    integrityOutcome: "passed",
    fingerprint,
    calibrationAdmitted,
  }
}

export async function finalizeDanceAttempt(input: {
  env: Env
  sessionId: string
  facts: DanceAttemptTerminalFacts
  now: string
  dependencies?: {
    controlClient: Client
    communityRepository: ReturnType<typeof getCommunityRepository>
    openCommunityWriteClient: typeof openCommunityWriteClient
  }
}): Promise<{ kind: "finalized" | "idempotent"; status: string }> {
  const controlClient = input.dependencies?.controlClient
    ?? getControlPlaneClient(input.env)
  const session = await loadSession(controlClient, input.sessionId)
  if (["finalized", "rejected", "failed"].includes(session.status)) {
    if (!session.resultDigest) {
      throw internalError("Terminal dance attempt is missing its result digest")
    }
    assertIdempotentDanceAttemptTerminalFacts(session.resultDigest, input.facts)
    return { kind: "idempotent", status: session.status }
  }
  if (session.status !== "grading" && session.status !== "submitted") {
    throw conflictError("Dance attempt session cannot be finalized")
  }

  const projection = await projectTerminal({
    env: input.env,
    controlClient,
    session,
    facts: input.facts,
    now: input.now,
  })
  const versions = factsVersions(input.facts)
  const calibrationVersion = versions?.calibration ?? session.calibrationVersion
  const calibrationChecksum =
    versions?.calibrationChecksum ?? session.calibrationChecksum
  const quality = "quality" in input.facts ? input.facts.quality : null
  const alignment = "alignment" in input.facts ? input.facts.alignment : null
  const selectedMirror =
    "selectedMirror" in input.facts ? input.facts.selectedMirror : null

  const communityRepository = input.dependencies?.communityRepository
    ?? getCommunityRepository(input.env)
  const openShard = input.dependencies?.openCommunityWriteClient
    ?? openCommunityWriteClient
  const shard = await openShard(
    input.env,
    communityRepository,
    session.communityId,
  )
  try {
    await shard.client.execute({
      sql: `
        INSERT INTO dance_attempt (
          dance_attempt_id, dance_attempt_session_id, user_id, community_id,
          post_id, song_artifact_bundle_id, dance_choreography_revision_id,
          activity_date, activity_timezone, status, score_bps, rank_eligible,
          quality_outcome, integrity_outcome, reason_code, coverage_bps,
          pose_detection_bps, duration_ratio_bps, selected_mirror,
          temporal_offset_ms, temporal_warp_bps, unmatched_coverage_bps,
          reference_content_sha256, reference_feature_sha256,
          pose_model_version, pose_model_sha256, feature_schema_version,
          scorer_version, calibration_version, calibration_checksum,
          calibration_admitted, fingerprint_policy_version,
          integrity_policy_version, whole_attempt_fingerprint_hmac,
          segment_fingerprint_hmac_json, grader_result_digest,
          completed_at, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
          ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26,
          ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, NULL, ?35, ?36, ?37
        )
        ON CONFLICT (dance_attempt_id) DO NOTHING
      `,
      args: [
        session.attemptId,
        session.sessionId,
        session.subjectUserId,
        session.communityId,
        session.songPostId,
        session.bundleId,
        session.revisionId,
        session.activityDate,
        session.activityTimezone,
        projection.status,
        projection.scoreBps,
        projection.rankEligible,
        projection.qualityOutcome,
        projection.integrityOutcome,
        projection.reason,
        quality?.usableCoverageBps ?? null,
        quality?.poseDetectionBps ?? null,
        quality?.durationRatioBps ?? null,
        selectedMirror,
        alignment?.globalOffsetMs ?? null,
        alignment?.totalWarpBps ?? null,
        alignment?.unmatchedCoverageBps ?? null,
        session.referenceContentSha256,
        session.referenceFeatureSha256,
        session.poseModelVersion,
        session.poseModelSha256,
        session.featureSchemaVersion,
        session.scorerVersion,
        calibrationVersion,
        calibrationChecksum,
        projection.calibrationAdmitted,
        session.fingerprintPolicyVersion,
        session.integrityPolicyVersion,
        projection.fingerprint,
        input.facts.resultDigest,
        new Date(input.facts.completedAt * 1000).toISOString(),
        input.now,
      ],
    })
    const persisted = await executeFirst(shard.client, {
      sql: `
        SELECT grader_result_digest
        FROM dance_attempt
        WHERE dance_attempt_id = ?1
      `,
      args: [session.attemptId],
    })
    if (
      stringOrNull(rowValue(persisted, "grader_result_digest"))
      !== input.facts.resultDigest
    ) {
      throw conflictError("Dance attempt already has different shard evidence")
    }
  } finally {
    await shard.close()
    await communityRepository.close?.()
  }

  if (projection.fingerprint) {
    await controlClient.execute({
      sql: `
        INSERT INTO dance_attempt_fingerprints (
          dance_attempt_id, dance_attempt_session_id, subject_user_id,
          dance_choreography_revision_id, fingerprint_policy_version,
          whole_attempt_hmac_sha256, segment_hmac_sha256_json,
          terminal_integrity_outcome, expires_at, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, CAST('[]' AS JSONB), ?7, ?8, ?9)
        ON CONFLICT (dance_attempt_id) DO NOTHING
      `,
      args: [
        session.attemptId,
        session.sessionId,
        session.subjectUserId,
        session.revisionId,
        session.fingerprintPolicyVersion,
        projection.fingerprint,
        projection.integrityOutcome,
        new Date(Date.parse(input.now) + FINGERPRINT_RETENTION_MS).toISOString(),
        input.now,
      ],
    })
  }

  const updated = await controlClient.execute({
    sql: `
      UPDATE dance_attempt_sessions
      SET status = ?2, terminal_outcome = ?3, terminal_reason = ?4,
        score_bps = ?5, calibration_version = ?6,
        calibration_checksum = ?7, calibration_admitted = ?8,
        grader_result_digest = ?9, finalized_at = ?10,
        grading_next_dispatch_at = NULL,
        grading_dispatch_claim_token = NULL,
        grading_dispatch_claim_expires_at = NULL,
        updated_at = ?10
      WHERE dance_attempt_session_id = ?1
        AND status IN ('submitted', 'grading')
    `,
    args: [
      session.sessionId,
      projection.controlStatus,
      projection.outcome,
      projection.reason,
      projection.scoreBps,
      calibrationVersion,
      calibrationChecksum,
      projection.calibrationAdmitted,
      input.facts.resultDigest,
      input.now,
    ],
  })
  if ((updated.rowsAffected ?? updated.rows.length) !== 1) {
    const current = await loadSession(controlClient, session.sessionId)
    if (!current.resultDigest) throw conflictError("Dance attempt finalization lost its claim")
    assertIdempotentDanceAttemptTerminalFacts(current.resultDigest, input.facts)
    return { kind: "idempotent", status: current.status }
  }

  return { kind: "finalized", status: projection.controlStatus }
}
