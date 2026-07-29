import { executeFirst } from "../db-helpers"
import { conflictError, internalError, notFoundError } from "../errors"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client, Transaction } from "../sql-client"
import { withTransaction } from "../transactions"
import {
  assertIdempotentDanceReferenceTerminalFacts,
  isPermanentDanceReferenceFailure,
  type DanceReferenceFailureCode,
  type DanceReferenceTerminalFacts,
} from "./choreography-reference-contract"

export type OperatorDanceChoreographySeed = {
  danceChoreographyId: string
  danceChoreographyRevisionId: string
  communityId: string
  hostPostId: string
  referencedSongPostId: string
  songArtifactBundleId: string
  creatorUserId: string
  official: boolean
  referenceStorageRef: string
  referenceContentSha256: string
  referenceMimeType: "video/mp4" | "video/webm" | "video/quicktime"
  referenceSizeBytes: number
  mirrorPolicy: "strict" | "allowed"
  now: string
}

export type DanceChoreographyRevisionRecord = {
  danceChoreographyId: string
  danceChoreographyRevisionId: string
  choreographyStatus: string
  revisionStatus: string
  failureCode: string | null
  referenceStorageRef: string
  referenceContentSha256: string
  referenceFeatureRef: string | null
}

export type FinalizeDanceReferenceResult =
  | { kind: "finalized"; record: DanceChoreographyRevisionRecord }
  | { kind: "idempotent"; record: DanceChoreographyRevisionRecord }
  | { kind: "retryable_failure"; reason: "scoring_unavailable"; record: DanceChoreographyRevisionRecord }

const REVISION_SELECT = `
  SELECT
    c.dance_choreography_id,
    c.community_id,
    c.host_post_id,
    c.referenced_song_post_id,
    c.song_artifact_bundle_id,
    c.creator_user_id,
    c.official,
    c.status AS choreography_status,
    r.dance_choreography_revision_id,
    r.status AS revision_status,
    r.failure_code,
    r.reference_storage_ref,
    r.reference_content_sha256,
    r.reference_mime_type,
    r.reference_size_bytes,
    r.mirror_policy,
    r.reference_feature_ref,
    r.reference_feature_sha256,
    r.reference_feature_size_bytes,
    r.reference_duration_ms,
    r.reference_width,
    r.reference_height,
    r.reference_fps_millihertz,
    r.pose_model_version,
    r.pose_model_sha256,
    r.pose_runtime_version,
    r.feature_schema_version,
    r.scorer_version,
    r.artifact_version
  FROM dance_choreography_revisions r
  JOIN dance_choreographies c
    ON c.dance_choreography_id = r.dance_choreography_id
  WHERE r.dance_choreography_revision_id = ?1
`

function requiredString(row: unknown, field: string): string {
  const value = stringOrNull(rowValue(row, field))
  if (!value) throw internalError(`Dance choreography revision is missing ${field}`)
  return value
}

function requiredNumber(row: unknown, field: string): number {
  const value = rowValue(row, field)
  const normalized = typeof value === "bigint" ? Number(value) : Number(value)
  if (!Number.isSafeInteger(normalized)) {
    throw internalError(`Dance choreography revision is missing ${field}`)
  }
  return normalized
}

function toRecord(row: unknown): DanceChoreographyRevisionRecord {
  return {
    danceChoreographyId: requiredString(row, "dance_choreography_id"),
    danceChoreographyRevisionId: requiredString(row, "dance_choreography_revision_id"),
    choreographyStatus: requiredString(row, "choreography_status"),
    revisionStatus: requiredString(row, "revision_status"),
    failureCode: stringOrNull(rowValue(row, "failure_code")),
    referenceStorageRef: requiredString(row, "reference_storage_ref"),
    referenceContentSha256: requiredString(row, "reference_content_sha256"),
    referenceFeatureRef: stringOrNull(rowValue(row, "reference_feature_ref")),
  }
}

function terminalFactsFromRow(row: unknown): DanceReferenceTerminalFacts {
  const status = requiredString(row, "revision_status")
  if (status === "failed") {
    const reason = requiredString(row, "failure_code")
    return { outcome: "failed", reason: reason as DanceReferenceFailureCode }
  }
  if (status !== "ready") {
    throw internalError("Dance choreography revision is not terminal")
  }
  return {
    outcome: "ready",
    referenceFeatureSha256: requiredString(row, "reference_feature_sha256"),
    referenceFeatureSizeBytes: requiredNumber(row, "reference_feature_size_bytes"),
    durationMs: requiredNumber(row, "reference_duration_ms"),
    width: requiredNumber(row, "reference_width"),
    height: requiredNumber(row, "reference_height"),
    fpsMillihertz: requiredNumber(row, "reference_fps_millihertz"),
    poseModelVersion: requiredString(row, "pose_model_version"),
    poseModelSha256: requiredString(row, "pose_model_sha256"),
    poseRuntimeVersion: requiredString(row, "pose_runtime_version"),
    featureSchemaVersion: requiredString(row, "feature_schema_version"),
    scorerVersion: requiredString(row, "scorer_version"),
    artifactVersion: requiredString(row, "artifact_version"),
  }
}

async function getRevisionForUpdate(
  tx: Transaction,
  revisionId: string,
): Promise<unknown | null> {
  return executeFirst(tx, {
    sql: `${REVISION_SELECT} FOR UPDATE`,
    args: [revisionId],
  })
}

export async function seedOperatorDanceChoreography(input: {
  client: Client
  seed: OperatorDanceChoreographySeed
}): Promise<{ kind: "created" | "idempotent"; record: DanceChoreographyRevisionRecord }> {
  return withTransaction(input.client, "write", async (tx) => {
    const seed = input.seed
    const inserted = await tx.execute({
      sql: `
        INSERT INTO dance_choreographies (
          dance_choreography_id, community_id, host_post_id, referenced_song_post_id,
          song_artifact_bundle_id, creator_user_id, official, status, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'processing', ?8, ?8)
        ON CONFLICT (community_id, host_post_id) DO NOTHING
        RETURNING dance_choreography_id
      `,
      args: [
        seed.danceChoreographyId,
        seed.communityId,
        seed.hostPostId,
        seed.referencedSongPostId,
        seed.songArtifactBundleId,
        seed.creatorUserId,
        seed.official ? 1 : 0,
        seed.now,
      ],
    })

    if (inserted.rows.length > 0) {
      await tx.execute({
        sql: `
          INSERT INTO dance_choreography_revisions (
            dance_choreography_revision_id, dance_choreography_id, revision_number,
            reference_storage_ref, reference_content_sha256, reference_mime_type,
            reference_size_bytes, mirror_policy, status, created_at
          ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, 'processing', ?8)
        `,
        args: [
          seed.danceChoreographyRevisionId,
          seed.danceChoreographyId,
          seed.referenceStorageRef,
          seed.referenceContentSha256,
          seed.referenceMimeType,
          seed.referenceSizeBytes,
          seed.mirrorPolicy,
          seed.now,
        ],
      })
      const row = await getRevisionForUpdate(tx, seed.danceChoreographyRevisionId)
      if (!row) throw internalError("Seeded dance choreography revision is missing")
      return { kind: "created", record: toRecord(row) }
    }

    const row = await executeFirst(tx, {
      sql: `
        ${REVISION_SELECT}
          AND c.community_id = ?2
          AND c.host_post_id = ?3
        ORDER BY r.revision_number ASC
        LIMIT 1
        FOR UPDATE
      `,
      args: [seed.danceChoreographyRevisionId, seed.communityId, seed.hostPostId],
    })
    if (!row) {
      throw conflictError("Host post already has a different choreography")
    }
    const immutableMatches =
      requiredString(row, "dance_choreography_id") === seed.danceChoreographyId
      && requiredString(row, "referenced_song_post_id") === seed.referencedSongPostId
      && requiredString(row, "song_artifact_bundle_id") === seed.songArtifactBundleId
      && requiredString(row, "creator_user_id") === seed.creatorUserId
      && requiredNumber(row, "official") === (seed.official ? 1 : 0)
      && requiredString(row, "reference_storage_ref") === seed.referenceStorageRef
      && requiredString(row, "reference_content_sha256") === seed.referenceContentSha256
      && requiredString(row, "reference_mime_type") === seed.referenceMimeType
      && requiredNumber(row, "reference_size_bytes") === seed.referenceSizeBytes
      && requiredString(row, "mirror_policy") === seed.mirrorPolicy
    if (!immutableMatches) {
      throw conflictError("Operator choreography seed was reused with different facts")
    }
    return { kind: "idempotent", record: toRecord(row) }
  })
}

export async function finalizeDanceChoreographyReference(input: {
  client: Client
  danceChoreographyRevisionId: string
  facts: DanceReferenceTerminalFacts
  referenceFeatureRef?: string
  now: string
}): Promise<FinalizeDanceReferenceResult> {
  return withTransaction(input.client, "write", async (tx) => {
    const row = await getRevisionForUpdate(tx, input.danceChoreographyRevisionId)
    if (!row) throw notFoundError("Dance choreography revision not found")
    const record = toRecord(row)

    if (record.revisionStatus === "ready" || record.revisionStatus === "failed") {
      assertIdempotentDanceReferenceTerminalFacts(
        terminalFactsFromRow(row),
        input.facts,
      )
      if (
        input.facts.outcome === "ready"
        && input.referenceFeatureRef !== record.referenceFeatureRef
      ) {
        throw conflictError("Dance reference already has a different feature object")
      }
      return { kind: "idempotent", record }
    }
    if (record.revisionStatus !== "processing") {
      throw conflictError("Dance choreography revision cannot be finalized")
    }

    if (input.facts.outcome === "failed") {
      if (!isPermanentDanceReferenceFailure(input.facts)) {
        return {
          kind: "retryable_failure",
          reason: "scoring_unavailable",
          record,
        }
      }
      await tx.execute({
        sql: `
          UPDATE dance_choreography_revisions
          SET status = 'failed', failure_code = ?2
          WHERE dance_choreography_revision_id = ?1 AND status = 'processing'
        `,
        args: [input.danceChoreographyRevisionId, input.facts.reason],
      })
      await tx.execute({
        sql: `
          UPDATE dance_choreographies
          SET status = 'failed', updated_at = ?2
          WHERE dance_choreography_id = ?1 AND status = 'processing'
        `,
        args: [record.danceChoreographyId, input.now],
      })
    } else {
      if (!input.referenceFeatureRef) {
        throw conflictError("Ready dance reference is missing its feature object")
      }
      await tx.execute({
        sql: `
          UPDATE dance_choreography_revisions
          SET status = 'ready',
              reference_duration_ms = ?2,
              reference_width = ?3,
              reference_height = ?4,
              reference_fps_millihertz = ?5,
              reference_feature_ref = ?6,
              reference_feature_sha256 = ?7,
              reference_feature_size_bytes = ?8,
              pose_model_version = ?9,
              pose_model_sha256 = ?10,
              pose_runtime_version = ?11,
              feature_schema_version = ?12,
              scorer_version = ?13,
              artifact_version = ?14,
              ready_at = ?15
          WHERE dance_choreography_revision_id = ?1 AND status = 'processing'
        `,
        args: [
          input.danceChoreographyRevisionId,
          input.facts.durationMs,
          input.facts.width,
          input.facts.height,
          input.facts.fpsMillihertz,
          input.referenceFeatureRef,
          input.facts.referenceFeatureSha256,
          input.facts.referenceFeatureSizeBytes,
          input.facts.poseModelVersion,
          input.facts.poseModelSha256,
          input.facts.poseRuntimeVersion,
          input.facts.featureSchemaVersion,
          input.facts.scorerVersion,
          input.facts.artifactVersion,
          input.now,
        ],
      })
      await tx.execute({
        sql: `
          UPDATE dance_choreographies
          SET status = 'ready', active_revision_id = ?2, updated_at = ?3
          WHERE dance_choreography_id = ?1 AND status = 'processing'
        `,
        args: [
          record.danceChoreographyId,
          input.danceChoreographyRevisionId,
          input.now,
        ],
      })
    }

    const finalized = await getRevisionForUpdate(tx, input.danceChoreographyRevisionId)
    if (!finalized) throw internalError("Finalized dance choreography revision is missing")
    return { kind: "finalized", record: toRecord(finalized) }
  })
}
