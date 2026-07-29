import { createHash } from "node:crypto"

import { badRequestError, conflictError } from "../errors"

export const DANCE_REFERENCE_PERMANENT_FAILURE_CODES = [
  "video_invalid",
  "video_limits_exceeded",
  "invalid_timeline",
  "multiple_people",
  "pose_result_invalid",
  "insufficient_pose_presence",
  "insufficient_coverage",
  "insufficient_motion",
] as const

export const DANCE_REFERENCE_TRANSIENT_FAILURE_CODES = [
  "scoring_unavailable",
] as const

export type DanceReferencePermanentFailureCode =
  typeof DANCE_REFERENCE_PERMANENT_FAILURE_CODES[number]
export type DanceReferenceTransientFailureCode =
  typeof DANCE_REFERENCE_TRANSIENT_FAILURE_CODES[number]
export type DanceReferenceFailureCode =
  | DanceReferencePermanentFailureCode
  | DanceReferenceTransientFailureCode

export type DanceReferenceReadyFacts = {
  outcome: "ready"
  referenceFeatureSha256: string
  referenceFeatureSizeBytes: number
  durationMs: number
  width: number
  height: number
  fpsMillihertz: number
  poseModelVersion: string
  poseModelSha256: string
  poseRuntimeVersion: string
  featureSchemaVersion: string
  scorerVersion: string
  artifactVersion: string
}

export type DanceReferenceFailedFacts = {
  outcome: "failed"
  reason: DanceReferenceFailureCode
}

export type DanceReferenceTerminalFacts =
  | DanceReferenceReadyFacts
  | DanceReferenceFailedFacts

const PERMANENT_FAILURES = new Set<string>(DANCE_REFERENCE_PERMANENT_FAILURE_CODES)
const TRANSIENT_FAILURES = new Set<string>(DANCE_REFERENCE_TRANSIENT_FAILURE_CODES)
const SHA256 = /^[0-9a-f]{64}$/

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw badRequestError(`${field} is invalid`)
  }
  return value
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw badRequestError(`${field} is invalid`)
  }
  return Number(value)
}

function sha256(value: unknown, field: string): string {
  const normalized = nonEmpty(value, field)
  if (!SHA256.test(normalized)) throw badRequestError(`${field} is invalid`)
  return normalized
}

function failureCode(value: unknown): DanceReferenceFailureCode {
  const normalized = nonEmpty(value, "reason")
  if (!PERMANENT_FAILURES.has(normalized) && !TRANSIENT_FAILURES.has(normalized)) {
    throw badRequestError("reason is invalid")
  }
  return normalized as DanceReferenceFailureCode
}

export function parseDanceReferenceTerminalFacts(
  value: Record<string, unknown>,
): DanceReferenceTerminalFacts {
  if (value.outcome === "failed") {
    return { outcome: "failed", reason: failureCode(value.reason) }
  }
  if (value.outcome !== "ready") throw badRequestError("outcome is invalid")

  const metrics = value.metrics
  const versions = value.versions
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw badRequestError("metrics is invalid")
  }
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
    throw badRequestError("versions is invalid")
  }
  const metricRecord = metrics as Record<string, unknown>
  const versionRecord = versions as Record<string, unknown>
  return {
    outcome: "ready",
    referenceFeatureSha256: sha256(
      value.reference_feature_sha256,
      "reference_feature_sha256",
    ),
    referenceFeatureSizeBytes: positiveInteger(
      value.reference_feature_size_bytes,
      "reference_feature_size_bytes",
      16 * 1024 * 1024,
    ),
    durationMs: positiveInteger(metricRecord.duration_ms, "duration_ms", 90_000),
    width: positiveInteger(metricRecord.width, "width", 2_160),
    height: positiveInteger(metricRecord.height, "height", 2_160),
    fpsMillihertz: positiveInteger(
      metricRecord.fps_millihertz,
      "fps_millihertz",
      240_000,
    ),
    poseModelVersion: nonEmpty(versionRecord.pose_model, "pose_model"),
    poseModelSha256: sha256(versionRecord.pose_model_sha256, "pose_model_sha256"),
    poseRuntimeVersion: nonEmpty(versionRecord.pose_runtime, "pose_runtime"),
    featureSchemaVersion: nonEmpty(versionRecord.feature_schema, "feature_schema"),
    scorerVersion: nonEmpty(versionRecord.scorer, "scorer"),
    artifactVersion: nonEmpty(versionRecord.artifact, "artifact"),
  }
}

export function isPermanentDanceReferenceFailure(
  facts: DanceReferenceFailedFacts,
): boolean {
  return PERMANENT_FAILURES.has(facts.reason)
}

export function canonicalDanceReferenceTerminalDigest(
  facts: DanceReferenceTerminalFacts,
): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(facts).sort(([left], [right]) =>
      left.localeCompare(right)
    )),
  )
  return createHash("sha256").update(canonical).digest("hex")
}

export function assertIdempotentDanceReferenceTerminalFacts(
  existing: DanceReferenceTerminalFacts,
  received: DanceReferenceTerminalFacts,
): void {
  if (
    canonicalDanceReferenceTerminalDigest(existing)
    !== canonicalDanceReferenceTerminalDigest(received)
  ) {
    throw conflictError("Dance reference already has different terminal facts")
  }
}
