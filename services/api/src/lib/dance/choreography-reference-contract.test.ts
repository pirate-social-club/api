import { describe, expect, test } from "bun:test"

import {
  assertIdempotentDanceReferenceTerminalFacts,
  canonicalDanceReferenceTerminalDigest,
  isPermanentDanceReferenceFailure,
  parseDanceReferenceTerminalFacts,
} from "./choreography-reference-contract"

const readyPayload = {
  outcome: "ready",
  reference_feature_sha256: "a".repeat(64),
  reference_feature_size_bytes: 2048,
  metrics: {
    duration_ms: 10_000,
    width: 576,
    height: 1024,
    fps_millihertz: 30_000,
  },
  versions: {
    pose_model: "pose_landmarker_full_float16_v1",
    pose_model_sha256: "b".repeat(64),
    pose_runtime: "0.10.35",
    feature_schema: "dance_pose_2d_gate0_v1",
    scorer: "dance_scorer_gate0_v1",
    artifact: "dance_reference_features_v1",
  },
}

describe("dance choreography reference callback contract", () => {
  test("normalizes ready facts and ignores delivery-only callback fields", () => {
    const first = parseDanceReferenceTerminalFacts({
      ...readyPayload,
      completed_at: 1,
      result_digest: "c".repeat(64),
    })
    const replay = parseDanceReferenceTerminalFacts({
      ...readyPayload,
      completed_at: 2,
      result_digest: "d".repeat(64),
    })

    expect(canonicalDanceReferenceTerminalDigest(first)).toBe(
      canonicalDanceReferenceTerminalDigest(replay),
    )
    expect(() => assertIdempotentDanceReferenceTerminalFacts(first, replay)).not.toThrow()
  })

  test("rejects a callback that changes any terminal scoring fact", () => {
    const existing = parseDanceReferenceTerminalFacts(readyPayload)
    const changed = parseDanceReferenceTerminalFacts({
      ...readyPayload,
      reference_feature_sha256: "e".repeat(64),
    })

    expect(() =>
      assertIdempotentDanceReferenceTerminalFacts(existing, changed)
    ).toThrow("different terminal facts")
  })

  test("distinguishes creator-actionable failures from retryable service failures", () => {
    const permanent = parseDanceReferenceTerminalFacts({
      outcome: "failed",
      reason: "multiple_people",
    })
    const transient = parseDanceReferenceTerminalFacts({
      outcome: "failed",
      reason: "scoring_unavailable",
    })

    expect(permanent.outcome).toBe("failed")
    expect(transient.outcome).toBe("failed")
    if (permanent.outcome !== "failed" || transient.outcome !== "failed") return
    expect(isPermanentDanceReferenceFailure(permanent)).toBe(true)
    expect(isPermanentDanceReferenceFailure(transient)).toBe(false)
  })

  test("fails closed on unknown reasons and incomplete ready metrics", () => {
    expect(() => parseDanceReferenceTerminalFacts({
      outcome: "failed",
      reason: "whatever_modal_said",
    })).toThrow("reason is invalid")
    expect(() => parseDanceReferenceTerminalFacts({
      ...readyPayload,
      metrics: { duration_ms: 10_000 },
    })).toThrow("width is invalid")
  })
})
