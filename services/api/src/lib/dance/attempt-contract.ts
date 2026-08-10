import { createHash } from "node:crypto"

import { badRequestError, conflictError } from "../errors"

export const DANCE_ATTEMPT_REJECTION_CODES = [
  "upload_invalid",
  "video_invalid",
  "duration_out_of_range",
  "insufficient_pose_presence",
  "insufficient_coverage",
  "insufficient_motion",
  "insufficient_alignment",
  "multiple_people",
  "reference_replay",
] as const

export type DanceAttemptRejectionCode =
  typeof DANCE_ATTEMPT_REJECTION_CODES[number]

type QualityFacts = {
  outcome: "passed" | "rejected"
  reason: DanceAttemptRejectionCode | null
  durationRatioBps: number
  poseDetectionBps: number
  usableCoverageBps: number
  maxMissingGapMs: number
}

type AlignmentFacts = {
  globalOffsetMs: number
  overlapBps: number
  totalWarpBps: number
  unmatchedCoverageBps: number
  timingScoreBps: number
}

type ComponentFacts = {
  anglesBps: number
  positionsBps: number
  velocityBps: number
  timingBps: number
  rawSimilarityBps: number
}

type VersionFacts = {
  scorer: string
  featureSchema: string
  calibration: string
  calibrationChecksum: string
  fingerprint: string
  poseModel: string
  poseModelSha256: string
  poseRuntime: string
  referenceArtifact: string
  referenceFeatureSha256: string
}

type ExtractionFacts = {
  durationMs: number
  decodedFrameCount: number
  sampledFrameCount: number
  poseDetectionBps: number
  usableCoverageBps: number
  maxMissingGapMs: number
  maximumPoseCount: number
  motionEnergyBps: number
}

export type DanceAttemptScoredFacts = {
  outcome: "scored"
  reason: null
  scoreBps: number
  calibrationAdmitted: boolean
  selectedMirror: "canonical" | "mirrored"
  quality: QualityFacts & { outcome: "passed"; reason: null }
  alignment: AlignmentFacts
  components: ComponentFacts
  canonicalFingerprintMaterialHex: string
  versions: VersionFacts
  extraction: ExtractionFacts
  completedAt: number
  resultDigest: string
}

export type DanceAttemptRejectedFacts = {
  outcome: "rejected"
  reason: DanceAttemptRejectionCode
  scoreBps: null
  calibrationAdmitted: boolean
  selectedMirror: "canonical" | "mirrored"
  quality: QualityFacts
  alignment: AlignmentFacts | null
  components: null
  canonicalFingerprintMaterialHex: null
  versions: VersionFacts
  extraction: ExtractionFacts
  completedAt: number
  resultDigest: string
}

export type DanceAttemptPregradeRejectedFacts = {
  outcome: "rejected"
  reason: Exclude<DanceAttemptRejectionCode, "insufficient_alignment" | "reference_replay">
  scoreBps: null
  pregrade: true
  completedAt: number
  resultDigest: string
}

export type DanceAttemptFailedFacts = {
  outcome: "failed"
  reason: "scoring_unavailable"
  completedAt: number
  resultDigest: string
}

export type DanceAttemptTerminalFacts =
  | DanceAttemptScoredFacts
  | DanceAttemptRejectedFacts
  | DanceAttemptPregradeRejectedFacts
  | DanceAttemptFailedFacts

const SHA256 = /^[0-9a-f]{64}$/
const FINGERPRINT_MATERIAL = /^(?:[0-9a-f]{2}){1,64}$/
const REJECTIONS = new Set<string>(DANCE_ATTEMPT_REJECTION_CODES)
const PREGRADE_REJECTIONS = new Set<string>([
  "upload_invalid",
  "video_invalid",
  "duration_out_of_range",
  "insufficient_pose_presence",
  "insufficient_coverage",
  "insufficient_motion",
  "multiple_people",
])

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestError(`${field} is invalid`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string, maximum = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw badRequestError(`${field} is invalid`)
  }
  return value
}

function sha256(value: unknown, field: string): string {
  const normalized = string(value, field, 64)
  if (!SHA256.test(normalized)) throw badRequestError(`${field} is invalid`)
  return normalized
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum
  ) {
    throw badRequestError(`${field} is invalid`)
  }
  return Number(value)
}

function bps(value: unknown, field: string, maximum = 10_000): number {
  return integer(value, field, 0, maximum)
}

function rejection(value: unknown, field = "reason"): DanceAttemptRejectionCode {
  const normalized = string(value, field)
  if (!REJECTIONS.has(normalized)) throw badRequestError(`${field} is invalid`)
  return normalized as DanceAttemptRejectionCode
}

function nullableRejection(value: unknown, field: string): DanceAttemptRejectionCode | null {
  return value === null ? null : rejection(value, field)
}

function parseQuality(value: unknown): QualityFacts {
  const source = record(value, "grade.quality")
  const outcome = source.outcome
  if (outcome !== "passed" && outcome !== "rejected") {
    throw badRequestError("grade.quality.outcome is invalid")
  }
  const reason = nullableRejection(source.reason, "grade.quality.reason")
  if ((outcome === "passed") !== (reason === null)) {
    throw badRequestError("grade.quality reason does not match outcome")
  }
  return {
    outcome,
    reason,
    durationRatioBps: bps(source.duration_ratio_bps, "grade.quality.duration_ratio_bps", 20_000),
    poseDetectionBps: bps(source.pose_detection_bps, "grade.quality.pose_detection_bps"),
    usableCoverageBps: bps(source.usable_coverage_bps, "grade.quality.usable_coverage_bps"),
    maxMissingGapMs: integer(source.max_missing_gap_ms, "grade.quality.max_missing_gap_ms", 0, 90_000),
  }
}

function parseAlignment(value: unknown): AlignmentFacts {
  const source = record(value, "grade.alignment")
  return {
    globalOffsetMs: integer(source.global_offset_ms, "grade.alignment.global_offset_ms", -90_000, 90_000),
    overlapBps: bps(source.overlap_bps, "grade.alignment.overlap_bps"),
    totalWarpBps: bps(source.total_warp_bps, "grade.alignment.total_warp_bps"),
    unmatchedCoverageBps: bps(
      source.unmatched_coverage_bps,
      "grade.alignment.unmatched_coverage_bps",
    ),
    timingScoreBps: bps(source.timing_score_bps, "grade.alignment.timing_score_bps"),
  }
}

function parseComponents(value: unknown): ComponentFacts {
  const source = record(value, "grade.components")
  return {
    anglesBps: bps(source.angles_bps, "grade.components.angles_bps"),
    positionsBps: bps(source.positions_bps, "grade.components.positions_bps"),
    velocityBps: bps(source.velocity_bps, "grade.components.velocity_bps"),
    timingBps: bps(source.timing_bps, "grade.components.timing_bps"),
    rawSimilarityBps: bps(source.raw_similarity_bps, "grade.components.raw_similarity_bps"),
  }
}

function parseVersions(value: unknown): VersionFacts {
  const source = record(value, "grade.versions")
  return {
    scorer: string(source.scorer, "grade.versions.scorer"),
    featureSchema: string(source.feature_schema, "grade.versions.feature_schema"),
    calibration: string(source.calibration, "grade.versions.calibration"),
    calibrationChecksum: sha256(
      source.calibration_checksum,
      "grade.versions.calibration_checksum",
    ),
    fingerprint: string(source.fingerprint, "grade.versions.fingerprint"),
    poseModel: string(source.pose_model, "grade.versions.pose_model"),
    poseModelSha256: sha256(
      source.pose_model_sha256,
      "grade.versions.pose_model_sha256",
    ),
    poseRuntime: string(source.pose_runtime, "grade.versions.pose_runtime"),
    referenceArtifact: string(
      source.reference_artifact,
      "grade.versions.reference_artifact",
    ),
    referenceFeatureSha256: sha256(
      source.reference_feature_sha256,
      "grade.versions.reference_feature_sha256",
    ),
  }
}

function parseExtraction(value: unknown): ExtractionFacts {
  const source = record(value, "extraction_metrics")
  return {
    durationMs: integer(source.duration_ms, "extraction_metrics.duration_ms", 1, 30_000),
    decodedFrameCount: integer(
      source.decoded_frame_count,
      "extraction_metrics.decoded_frame_count",
      1,
      5_400,
    ),
    sampledFrameCount: integer(
      source.sampled_frame_count,
      "extraction_metrics.sampled_frame_count",
      1,
      5_400,
    ),
    poseDetectionBps: bps(
      source.pose_detection_bps,
      "extraction_metrics.pose_detection_bps",
    ),
    usableCoverageBps: bps(
      source.usable_coverage_bps,
      "extraction_metrics.usable_coverage_bps",
    ),
    maxMissingGapMs: integer(
      source.max_missing_gap_ms,
      "extraction_metrics.max_missing_gap_ms",
      0,
      90_000,
    ),
    maximumPoseCount: integer(
      source.maximum_pose_count,
      "extraction_metrics.maximum_pose_count",
      0,
      16,
    ),
    motionEnergyBps: bps(
      source.motion_energy_bps,
      "extraction_metrics.motion_energy_bps",
    ),
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const source = value as Record<string, unknown>
  return `{${Object.keys(source).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(source[key])}`
  ).join(",")}}`
}

function verifyResultDigest(value: Record<string, unknown>): string {
  const received = sha256(value.result_digest, "result_digest")
  const payload = { ...value }
  delete payload.result_digest
  const expected = createHash("sha256").update(stableJson(payload)).digest("hex")
  if (received !== expected) throw badRequestError("result_digest is invalid")
  return received
}

export function parseDanceAttemptTerminalFacts(
  value: Record<string, unknown>,
): DanceAttemptTerminalFacts {
  const completedAt = integer(value.completed_at, "completed_at", 1, 4_102_444_800)
  const resultDigest = verifyResultDigest(value)
  if (value.outcome === "failed") {
    if (value.reason !== "scoring_unavailable") {
      throw badRequestError("reason is invalid")
    }
    return { outcome: "failed", reason: "scoring_unavailable", completedAt, resultDigest }
  }
  if (value.outcome !== "scored" && value.outcome !== "rejected") {
    throw badRequestError("outcome is invalid")
  }
  if (value.outcome === "rejected" && value.grade === undefined) {
    const reason = rejection(value.reason)
    if (!PREGRADE_REJECTIONS.has(reason)) {
      throw badRequestError("pregrade rejection reason is invalid")
    }
    return {
      outcome: "rejected",
      reason: reason as DanceAttemptPregradeRejectedFacts["reason"],
      scoreBps: null,
      pregrade: true,
      completedAt,
      resultDigest,
    }
  }

  const grade = record(value.grade, "grade")
  if (grade.outcome !== value.outcome) {
    throw badRequestError("grade outcome does not match result")
  }
  const quality = parseQuality(grade.quality)
  const versions = parseVersions(grade.versions)
  const extraction = parseExtraction(value.extraction_metrics)
  if (typeof grade.calibration_admitted !== "boolean") {
    throw badRequestError("grade.calibration_admitted is invalid")
  }
  const selectedMirror = grade.selected_mirror
  if (selectedMirror !== "canonical" && selectedMirror !== "mirrored") {
    throw badRequestError("grade.selected_mirror is invalid")
  }

  if (value.outcome === "rejected") {
    const reason = rejection(grade.reason, "grade.reason")
    if (
      grade.score_bps !== null
      || grade.components !== null
      || grade.canonical_fingerprint_material_hex !== null
    ) {
      throw badRequestError("rejected grade contains scored facts")
    }
    return {
      outcome: "rejected",
      reason,
      scoreBps: null,
      calibrationAdmitted: grade.calibration_admitted,
      selectedMirror,
      quality,
      alignment: grade.alignment === null ? null : parseAlignment(grade.alignment),
      components: null,
      canonicalFingerprintMaterialHex: null,
      versions,
      extraction,
      completedAt,
      resultDigest,
    }
  }

  if (grade.reason !== null || quality.outcome !== "passed" || quality.reason !== null) {
    throw badRequestError("scored grade contains rejection facts")
  }
  const fingerprintMaterial = string(
    grade.canonical_fingerprint_material_hex,
    "grade.canonical_fingerprint_material_hex",
    128,
  )
  if (!FINGERPRINT_MATERIAL.test(fingerprintMaterial)) {
    throw badRequestError("grade.canonical_fingerprint_material_hex is invalid")
  }
  return {
    outcome: "scored",
    reason: null,
    scoreBps: bps(grade.score_bps, "grade.score_bps"),
    calibrationAdmitted: grade.calibration_admitted,
    selectedMirror,
    quality: quality as DanceAttemptScoredFacts["quality"],
    alignment: parseAlignment(grade.alignment),
    components: parseComponents(grade.components),
    canonicalFingerprintMaterialHex: fingerprintMaterial,
    versions,
    extraction,
    completedAt,
    resultDigest,
  }
}

export function assertIdempotentDanceAttemptTerminalFacts(
  existingResultDigest: string,
  received: DanceAttemptTerminalFacts,
): void {
  if (existingResultDigest !== received.resultDigest) {
    throw conflictError("Dance attempt already has different terminal facts")
  }
}
