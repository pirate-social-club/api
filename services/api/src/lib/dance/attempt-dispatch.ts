import type { Env } from "../../env"
import { providerUnavailable } from "../errors"
import { getControlPlaneClient } from "../runtime-deps"
import type { Client } from "../sql-client"
import {
  acceptDanceAttemptDispatch,
  claimDueDanceAttemptDispatch,
  rejectDanceAttemptDispatch,
} from "./attempt-dispatch-repository"
import { buildDanceAttemptDownloadUrl } from "./attempt-storage"
import { buildS3PresignedUrl } from "../storage/s3-signing"
import { assertDanceStorageObjectKey } from "./choreography-reference-storage"
import { resolveFilebaseConfig } from "../storage/filebase-config"
import { signDanceGraderRequest } from "./grader-callback-auth"

const CLAIM_TTL_MS = 2 * 60_000
const CALLBACK_DEADLINE_MS = 10 * 60_000
const REQUEST_TIMEOUT_MS = 15_000
const MAX_DISPATCHES_PER_SWEEP = 5

function config(env: Env): {
  endpoint: URL
  callbackOrigin: URL
  hmacKey: string
  keyVersion: string
} {
  const endpoint = new URL(String(env.DANCE_GRADER_ATTEMPT_DISPATCH_URL ?? "").trim())
  const callbackOrigin = new URL(String(env.PIRATE_API_PUBLIC_ORIGIN ?? "").trim())
  const hmacKey = String(env.DANCE_GRADER_DISPATCH_HMAC_KEY ?? "")
  const keyVersion = String(env.DANCE_GRADER_DISPATCH_KEY_VERSION ?? "").trim()
  if (
    endpoint.protocol !== "https:"
    || callbackOrigin.protocol !== "https:"
    || hmacKey.length < 32
    || !keyVersion
  ) {
    throw providerUnavailable("Dance attempt dispatch is not configured")
  }
  return { endpoint, callbackOrigin, hmacKey, keyVersion }
}

export function isDanceAttemptDispatchConfigured(env: Env): boolean {
  try {
    config(env)
    return Boolean(
      env.CONTROL_PLANE_DATABASE_URL
      && env.DANCE_ATTEMPT_S3_ENDPOINT
      && env.DANCE_ATTEMPT_S3_ACCESS_KEY
      && env.DANCE_ATTEMPT_S3_SECRET_KEY
      && env.DANCE_ATTEMPT_S3_BUCKET
      && env.FILEBASE_S3_ACCESS_KEY
      && env.FILEBASE_S3_SECRET_KEY
      && env.FILEBASE_MEDIA_BUCKET,
    )
  } catch {
    return false
  }
}

function retryDelayMs(attempt: number): number {
  return [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000][
    Math.max(0, Math.min(attempt - 1, 3))
  ]
}

export async function dispatchDueDanceAttempts(input: {
  env: Env
  client?: Client
  fetchFn?: typeof fetch
  now?: () => number
  maxDispatches?: number
}): Promise<{ claimed: number; dispatched: number; retry_scheduled: number; claim_lost: number }> {
  const summary = { claimed: 0, dispatched: 0, retry_scheduled: 0, claim_lost: 0 }
  if (!isDanceAttemptDispatchConfigured(input.env)) return summary
  const resolved = config(input.env)
  const client = input.client ?? getControlPlaneClient(input.env)
  const fetchFn = input.fetchFn ?? fetch
  const now = input.now ?? (() => Date.now())
  const limit = Math.max(1, Math.min(input.maxDispatches ?? 5, MAX_DISPATCHES_PER_SWEEP))

  for (let index = 0; index < limit; index += 1) {
    const claimedAt = now()
    const claimToken = `dac_${crypto.randomUUID().replaceAll("-", "")}`
    const record = await claimDueDanceAttemptDispatch({
      client,
      now: new Date(claimedAt).toISOString(),
      claimToken,
      claimExpiresAt: new Date(claimedAt + CLAIM_TTL_MS).toISOString(),
    })
    if (!record) break
    summary.claimed += 1
    try {
      const mediaGetUrl = await buildDanceAttemptDownloadUrl({
        env: input.env,
        objectKey: record.uploadObjectKey,
        now: new Date(claimedAt),
      })
      const referenceGetUrl = await buildS3PresignedUrl({
        method: "GET",
        config: resolveFilebaseConfig(input.env),
        objectKey: assertDanceStorageObjectKey(record.referenceFeatureRef),
        bodyHashMode: "unsigned",
        expiresInSeconds: 900,
        now: new Date(claimedAt),
      })
      const callbackUrl = new URL(
        `/dance-attempts/${encodeURIComponent(record.sessionId)}/callback`,
        resolved.callbackOrigin,
      )
      const payload = {
        subject: record.sessionId,
        attempt_id: record.attemptId,
        media_get_url: mediaGetUrl,
        artifact_get_url: referenceGetUrl.toString(),
        callback_url: callbackUrl.toString(),
        attempt_content_sha256: record.observedContentSha256,
        max_media_bytes: record.observedSizeBytes,
        reference_content_sha256: record.referenceContentSha256,
        reference_feature_sha256: record.referenceFeatureSha256,
        max_artifact_bytes: record.referenceFeatureSizeBytes,
        pose_model_version: record.poseModelVersion,
        pose_model_sha256: record.poseModelSha256,
        feature_schema_version: record.featureSchemaVersion,
        scorer_version: record.scorerVersion,
        artifact_version: record.artifactVersion,
        calibration_version: record.calibrationVersion,
        calibration_checksum: record.calibrationChecksum,
        fingerprint_policy_version: record.fingerprintPolicyVersion,
        integrity_policy_version: record.integrityPolicyVersion,
        mirror_policy: record.mirrorPolicy,
      }
      const body = JSON.stringify(payload)
      const signature = signDanceGraderRequest({
        key: resolved.hmacKey,
        method: "POST",
        path: resolved.endpoint.pathname,
        timestamp: Math.floor(claimedAt / 1000),
        subject: record.sessionId,
        body: new TextEncoder().encode(body),
      })
      const abort = new AbortController()
      const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetchFn(resolved.endpoint, {
          method: "POST",
          redirect: "manual",
          signal: abort.signal,
          headers: {
            "content-type": "application/json",
            "x-dance-grader-key-version": resolved.keyVersion,
            "x-dance-grader-timestamp": String(Math.floor(claimedAt / 1000)),
            "x-dance-grader-signature": signature,
          },
          body,
        })
      } finally {
        clearTimeout(timeout)
      }
      if (!response.ok) throw new Error(`modal_http_${response.status}`)
      const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null
      const dispatchId = responseBody?.dispatch_id
      if (typeof dispatchId !== "string" || !dispatchId || dispatchId.length > 200) {
        throw new Error("modal_invalid_response")
      }
      const accepted = await acceptDanceAttemptDispatch({
        client,
        sessionId: record.sessionId,
        claimToken,
        dispatchId,
        now: new Date(now()).toISOString(),
        callbackDeadline: new Date(claimedAt + CALLBACK_DEADLINE_MS).toISOString(),
      })
      summary[accepted ? "dispatched" : "claim_lost"] += 1
    } catch (error) {
      const errorCode = error instanceof Error
        ? error.message.slice(0, 64)
        : "modal_dispatch_unavailable"
      const accepted = await rejectDanceAttemptDispatch({
        client,
        sessionId: record.sessionId,
        claimToken,
        errorCode,
        retryAt: new Date(now() + retryDelayMs(record.dispatchAttemptCount)).toISOString(),
        now: new Date(now()).toISOString(),
      })
      summary[accepted ? "retry_scheduled" : "claim_lost"] += 1
    }
  }
  return summary
}
