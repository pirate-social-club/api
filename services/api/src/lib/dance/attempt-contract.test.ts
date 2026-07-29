import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"

import {
  assertIdempotentDanceAttemptTerminalFacts,
  parseDanceAttemptTerminalFacts,
} from "./attempt-contract"

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const source = value as Record<string, unknown>
  return `{${Object.keys(source).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(source[key])}`
  ).join(",")}}`
}

function signedResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const result: Record<string, unknown> = {
    subject: "dat_1",
    outcome: "scored",
    reason: null,
    grade: {
      outcome: "scored",
      reason: null,
      score_bps: 5112,
      calibration_admitted: false,
      selected_mirror: "mirrored",
      quality: {
        outcome: "passed",
        reason: null,
        duration_ratio_bps: 9900,
        pose_detection_bps: 10000,
        usable_coverage_bps: 9636,
        max_missing_gap_ms: 0,
      },
      alignment: {
        global_offset_ms: 209,
        overlap_bps: 9162,
        total_warp_bps: 929,
        unmatched_coverage_bps: 838,
        timing_score_bps: 7087,
      },
      components: {
        angles_bps: 6681,
        positions_bps: 7951,
        velocity_bps: 7675,
        timing_bps: 7087,
        raw_similarity_bps: 6596,
      },
      canonical_fingerprint_material_hex: "0a0b0c",
      versions: {
        scorer: "dance_scorer_gate0_v1",
        feature_schema: "dance_pose_2d_gate0_v1",
        calibration: "dance_calibration_gate0_provisional_v1",
        calibration_checksum: "1".repeat(64),
        fingerprint: "dance_motion_fingerprint_gate0_v1",
        pose_model: "pose_landmarker_full_float16_v1",
        pose_model_sha256: "2".repeat(64),
        pose_runtime: "0.10.35",
        reference_artifact: "dance_reference_features_v1",
        reference_feature_sha256: "3".repeat(64),
      },
    },
    extraction_metrics: {
      duration_ms: 11011,
      decoded_frame_count: 330,
      sampled_frame_count: 165,
      pose_detection_bps: 10000,
      usable_coverage_bps: 9636,
      max_missing_gap_ms: 0,
      maximum_pose_count: 1,
      motion_energy_bps: 804,
    },
    completed_at: 1785330000,
    ...overrides,
  }
  result.result_digest = createHash("sha256").update(stableJson(result)).digest("hex")
  return result
}

describe("dance attempt callback contract", () => {
  test("parses exact provisional coaching facts without making them eligible", () => {
    const facts = parseDanceAttemptTerminalFacts(signedResult())
    expect(facts).toMatchObject({
      outcome: "scored",
      scoreBps: 5112,
      calibrationAdmitted: false,
      selectedMirror: "mirrored",
    })
  })

  test("rejects tampering after the grader computed its result digest", () => {
    const value = signedResult()
    ;(value.grade as Record<string, unknown>).score_bps = 9000
    expect(() => parseDanceAttemptTerminalFacts(value)).toThrow("result_digest")
  })

  test("accepts scorer sequence rejection codes and rejects unknown codes", () => {
    const grade = signedResult().grade as Record<string, unknown>
    const rejectedGrade = {
      ...grade,
      outcome: "rejected",
      reason: "insufficient_alignment",
      score_bps: null,
      components: null,
      canonical_fingerprint_material_hex: null,
    }
    expect(parseDanceAttemptTerminalFacts(signedResult({
      outcome: "rejected",
      reason: "insufficient_alignment",
      grade: rejectedGrade,
    }))).toMatchObject({
      outcome: "rejected",
      reason: "insufficient_alignment",
    })
    expect(() => parseDanceAttemptTerminalFacts(signedResult({
      outcome: "rejected",
      reason: "made_up",
      grade: { ...rejectedGrade, reason: "made_up" },
    }))).toThrow("grade.reason")
  })

  test("terminal replay is idempotent only for the identical grader digest", () => {
    const facts = parseDanceAttemptTerminalFacts(signedResult())
    expect(() => assertIdempotentDanceAttemptTerminalFacts(
      facts.resultDigest,
      facts,
    )).not.toThrow()
    expect(() => assertIdempotentDanceAttemptTerminalFacts(
      "f".repeat(64),
      facts,
    )).toThrow("different terminal facts")
  })
})
