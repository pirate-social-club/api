import { describe, expect, test } from "bun:test"

import type { DanceAttemptScoredFacts } from "./attempt-contract"
import { finalizeDanceAttempt, hasVersionMismatch } from "./attempt-finalize-service"

const session = {
  dance_attempt_session_id: "dse_1",
  dance_attempt_id: "dat_1",
  subject_user_id: "usr_1",
  community_id: "cmty_1",
  referenced_song_post_id: "song_1",
  song_artifact_bundle_id: "sab_1",
  dance_choreography_revision_id: "dcr_1",
  activity_date: "2026-07-30",
  activity_timezone: "UTC",
  status: "grading",
  grader_result_digest: null,
  reference_content_sha256: "a".repeat(64),
  reference_feature_sha256: "b".repeat(64),
  pose_model_version: "pose_v1",
  pose_model_sha256: "c".repeat(64),
  feature_schema_version: "features_v1",
  scorer_version: "scorer_v1",
  artifact_version: "artifact_v1",
  required_calibration_version: "dance_calibration_gate0_provisional_v1",
  required_calibration_checksum: "d".repeat(64),
  required_fingerprint_policy_version: "fingerprint_v1",
  required_integrity_policy_version: "integrity_v1",
  start_cue_policy_version: "dance_start_cue_gross_body_v1",
  start_cue_kind: "hands_on_head",
}

function scoredFacts(): DanceAttemptScoredFacts {
  return {
    outcome: "scored",
    reason: null,
    scoreBps: 9200,
    calibrationAdmitted: true,
    selectedMirror: "canonical",
    quality: {
      outcome: "passed",
      reason: null,
      durationRatioBps: 10_000,
      poseDetectionBps: 9900,
      usableCoverageBps: 9800,
      maxMissingGapMs: 30,
    },
    alignment: {
      globalOffsetMs: 10,
      overlapBps: 9900,
      totalWarpBps: 100,
      unmatchedCoverageBps: 100,
      timingScoreBps: 9500,
    },
    components: {
      anglesBps: 9000,
      positionsBps: 9000,
      velocityBps: 9000,
      timingBps: 9500,
      rawSimilarityBps: 9100,
    },
    canonicalFingerprintMaterialHex: "0a0b0c",
    versions: {
      scorer: "scorer_v1",
      featureSchema: "features_v1",
      calibration: "dance_calibration_gate0_provisional_v1",
      calibrationChecksum: "d".repeat(64),
      fingerprint: "fingerprint_v1",
      poseModel: "pose_v1",
      poseModelSha256: "c".repeat(64),
      poseRuntime: "runtime_v1",
      referenceArtifact: "artifact_v1",
      referenceFeatureSha256: "b".repeat(64),
    },
    extraction: {
      durationMs: 10_000,
      decodedFrameCount: 300,
      sampledFrameCount: 150,
      poseDetectionBps: 9900,
      usableCoverageBps: 9800,
      maxMissingGapMs: 30,
      maximumPoseCount: 1,
      motionEnergyBps: 1000,
    },
    completedAt: 1_785_420_000,
    resultDigest: "e".repeat(64),
    startCue: {
      policyVersion: "dance_start_cue_gross_body_v1",
      kind: "hands_on_head",
      outcome: "passed",
      scoredWindowStartMs: 500,
    },
  }
}

describe("dance attempt finalization", () => {
  test("persists coaching evidence but refuses rank eligibility for provisional calibration", async () => {
    let shardInsertArgs: unknown[] = []
    const shardExecute = async (query: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof query === "string" ? query : query.sql
      const args = typeof query === "string" ? [] : (query.args ?? [])
      if (sql.includes("INSERT INTO dance_attempt")) {
        shardInsertArgs = args
        return { rows: [], rowsAffected: 1 }
      }
      if (sql.includes("SELECT grader_result_digest")) {
        return { rows: [{ grader_result_digest: "e".repeat(64) }] }
      }
      throw new Error(`Unexpected shard SQL: ${sql}`)
    }
    const controlExecute = async (
      query: string | { sql: string; args?: unknown[] },
    ) => {
      const sql = typeof query === "string" ? query : query.sql
      if (sql.includes("SELECT * FROM dance_attempt_sessions")) {
        return { rows: [session] }
      }
      if (sql.includes("FROM dance_attempt_fingerprints")) {
        return { rows: [] }
      }
      if (sql.includes("INSERT INTO dance_attempt_fingerprints")) {
        return { rows: [], rowsAffected: 1 }
      }
      if (sql.includes("UPDATE dance_attempt_sessions")) {
        return { rows: [], rowsAffected: 1 }
      }
      throw new Error(`Unexpected control SQL: ${sql}`)
    }
    const result = await finalizeDanceAttempt({
      env: {
        DANCE_ATTEMPT_FINGERPRINT_HMAC_KEY: "f".repeat(32),
      } as never,
      sessionId: "dse_1",
      facts: scoredFacts(),
      now: "2026-07-30T00:00:00.000Z",
      dependencies: {
        controlClient: { execute: controlExecute } as never,
        communityRepository: { close: async () => {} } as never,
        openCommunityWriteClient: async () => ({
          client: { execute: shardExecute } as never,
          close: async () => {},
          source: "d1",
        }),
      },
    })
    expect(result).toEqual({ kind: "finalized", status: "finalized" })
    expect(shardInsertArgs[4]).toBe("song_1")
    expect(shardInsertArgs[9]).toBe("passed")
    expect(shardInsertArgs[11]).toBe(0)
    expect(shardInsertArgs[30]).toBe(0)
  })

  test("fails closed when an assigned cue is omitted from grader facts", () => {
    const facts = scoredFacts()
    delete facts.startCue
    expect(hasVersionMismatch({
      scorerVersion: "scorer_v1",
      featureSchemaVersion: "features_v1",
      calibrationVersion: "dance_calibration_gate0_provisional_v1",
      calibrationChecksum: "d".repeat(64),
      fingerprintPolicyVersion: "fingerprint_v1",
      poseModelVersion: "pose_v1",
      poseModelSha256: "c".repeat(64),
      artifactVersion: "artifact_v1",
      referenceFeatureSha256: "b".repeat(64),
      startCuePolicyVersion: "dance_start_cue_gross_body_v1",
      startCueKind: "hands_on_head",
    } as never, facts)).toBe(true)
  })
})
