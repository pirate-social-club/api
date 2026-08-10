import { providerUnavailable } from "../errors"
import { getControlPlaneClient } from "../runtime-deps"
import type { Client } from "../sql-client"
import type { Env } from "../../env"
import {
  acceptDanceReferenceDispatch,
  claimDueDanceReferenceDispatch,
  exhaustDueDanceReferenceDispatch,
  rejectDanceReferenceDispatch,
} from "./choreography-reference-repository"
import { buildDanceReferenceSignedUrls } from "./choreography-reference-storage"
import { signDanceGraderRequest } from "./grader-callback-auth"

const POSE_MODEL_VERSION = "pose_landmarker_full_float16_v1"
const POSE_MODEL_SHA256 =
  "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1"
const FEATURE_SCHEMA_VERSION = "dance_pose_2d_gate0_v1"
const SCORER_VERSION = "dance_scorer_gate0_v2"
const CLAIM_TTL_MS = 2 * 60_000
const REQUEST_TIMEOUT_MS = 15_000
const CALLBACK_DEADLINE_MS = 10 * 60_000
const MAX_DISPATCHES_PER_SWEEP = 5

type DispatchResponse = { dispatch_id: string }

export type DanceReferenceDispatchSummary = {
  configured: boolean
  claimed: number
  dispatched: number
  retry_scheduled: number
  exhausted: number
  claim_lost: number
}

function requiredDispatchConfig(env: Env): {
  endpoint: URL
  hmacKey: string
  keyVersion: string
  callbackOrigin: URL
} {
  const endpointValue = String(env.DANCE_GRADER_DISPATCH_URL ?? "").trim()
  const hmacKey = String(env.DANCE_GRADER_DISPATCH_HMAC_KEY ?? "")
  const keyVersion = String(env.DANCE_GRADER_DISPATCH_KEY_VERSION ?? "").trim()
  const callbackOriginValue = String(env.PIRATE_API_PUBLIC_ORIGIN ?? "").trim()
  if (!endpointValue || hmacKey.length < 32 || !keyVersion || !callbackOriginValue) {
    throw providerUnavailable("Dance grader dispatch is not configured")
  }
  const endpoint = new URL(endpointValue)
  const callbackOrigin = new URL(callbackOriginValue)
  if (endpoint.protocol !== "https:" || callbackOrigin.protocol !== "https:") {
    throw providerUnavailable("Dance grader dispatch requires HTTPS origins")
  }
  return { endpoint, hmacKey, keyVersion, callbackOrigin }
}

export function isDanceReferenceDispatchConfigured(env: Env): boolean {
  try {
    requiredDispatchConfig(env)
    return Boolean(
      env.FILEBASE_S3_ACCESS_KEY
      && env.FILEBASE_S3_SECRET_KEY
      && env.FILEBASE_MEDIA_BUCKET
      && env.CONTROL_PLANE_DATABASE_URL,
    )
  } catch {
    return false
  }
}

function canonicalBody(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function retryDelayMs(attempt: number): number {
  return [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000][
    Math.max(0, Math.min(attempt - 1, 3))
  ]
}

function boundedDispatchError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "modal_dispatch_timeout"
  }
  if (error instanceof Error && error.message.startsWith("modal_http_")) {
    return error.message.slice(0, 64)
  }
  if (error instanceof Error && error.message === "modal_invalid_response") {
    return error.message
  }
  return "modal_dispatch_unavailable"
}

export async function postDanceReferenceDispatch(input: {
  fetchFn: typeof fetch
  endpoint: URL
  hmacKey: string
  keyVersion: string
  subject: string
  payload: Record<string, unknown>
  nowSeconds: number
}): Promise<DispatchResponse> {
  const body = canonicalBody(input.payload)
  const bodyBytes = new TextEncoder().encode(body)
  const signature = signDanceGraderRequest({
    key: input.hmacKey,
    method: "POST",
    path: input.endpoint.pathname,
    timestamp: input.nowSeconds,
    subject: input.subject,
    body: bodyBytes,
  })
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await input.fetchFn(input.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        "x-dance-grader-key-version": input.keyVersion,
        "x-dance-grader-timestamp": String(input.nowSeconds),
        "x-dance-grader-signature": signature,
      },
      body,
    })
    if (!response.ok) throw new Error(`modal_http_${response.status}`)
    const value = await response.json().catch(() => null) as Record<string, unknown> | null
    const dispatchId = value?.dispatch_id
    if (typeof dispatchId !== "string" || dispatchId.length === 0 || dispatchId.length > 200) {
      throw new Error("modal_invalid_response")
    }
    return { dispatch_id: dispatchId }
  } finally {
    clearTimeout(timeout)
  }
}

export async function dispatchDueDanceReferences(input: {
  env: Env
  client?: Client
  fetchFn?: typeof fetch
  now?: () => number
  maxDispatches?: number
}): Promise<DanceReferenceDispatchSummary> {
  const summary: DanceReferenceDispatchSummary = {
    configured: false,
    claimed: 0,
    dispatched: 0,
    retry_scheduled: 0,
    exhausted: 0,
    claim_lost: 0,
  }
  if (!isDanceReferenceDispatchConfigured(input.env)) return summary
  summary.configured = true

  const config = requiredDispatchConfig(input.env)
  const client = input.client ?? getControlPlaneClient(input.env)
  const fetchFn = input.fetchFn ?? fetch
  const now = input.now ?? (() => Date.now())
  const limit = Math.max(
    1,
    Math.min(input.maxDispatches ?? MAX_DISPATCHES_PER_SWEEP, MAX_DISPATCHES_PER_SWEEP),
  )

  for (let index = 0; index < limit; index += 1) {
    const claimedAtMs = now()
    if (await exhaustDueDanceReferenceDispatch({
      client,
      now: new Date(claimedAtMs).toISOString(),
    })) {
      summary.exhausted += 1
      continue
    }
    const claimToken = `drc_${crypto.randomUUID().replace(/-/g, "")}`
    const record = await claimDueDanceReferenceDispatch({
      client,
      now: new Date(claimedAtMs).toISOString(),
      claimToken,
      claimExpiresAt: new Date(claimedAtMs + CLAIM_TTL_MS).toISOString(),
    })
    if (!record) break
    summary.claimed += 1

    try {
      const signed = await buildDanceReferenceSignedUrls({
        env: input.env,
        referenceStorageRef: record.referenceStorageRef,
        danceChoreographyRevisionId: record.danceChoreographyRevisionId,
        now: new Date(claimedAtMs),
      })
      const callbackUrl = new URL(
        `/dance-choreographies/revisions/${
          encodeURIComponent(record.danceChoreographyRevisionId)
        }/reference-callback`,
        config.callbackOrigin,
      )
      const payload = {
        subject: record.danceChoreographyRevisionId,
        media_get_url: signed.mediaGetUrl,
        artifact_put_url: signed.artifactPutUrl,
        callback_url: callbackUrl.toString(),
        reference_content_sha256: record.referenceContentSha256,
        max_media_bytes: record.referenceSizeBytes,
        pose_model_version: POSE_MODEL_VERSION,
        pose_model_sha256: POSE_MODEL_SHA256,
        feature_schema_version: FEATURE_SCHEMA_VERSION,
        scorer_version: SCORER_VERSION,
      }
      const dispatched = await postDanceReferenceDispatch({
        fetchFn,
        endpoint: config.endpoint,
        hmacKey: config.hmacKey,
        keyVersion: config.keyVersion,
        subject: record.danceChoreographyRevisionId,
        payload,
        nowSeconds: Math.floor(claimedAtMs / 1000),
      })
      const accepted = await acceptDanceReferenceDispatch({
        client,
        danceChoreographyRevisionId: record.danceChoreographyRevisionId,
        claimToken,
        dispatchId: dispatched.dispatch_id,
        now: new Date(now()).toISOString(),
        callbackDeadline: new Date(claimedAtMs + CALLBACK_DEADLINE_MS).toISOString(),
      })
      if (accepted) summary.dispatched += 1
      else summary.claim_lost += 1
    } catch (error) {
      const failedAtMs = now()
      const outcome = await rejectDanceReferenceDispatch({
        client,
        danceChoreographyRevisionId: record.danceChoreographyRevisionId,
        claimToken,
        errorCode: boundedDispatchError(error),
        retryAt: new Date(
          failedAtMs + retryDelayMs(record.referenceDispatchAttemptCount),
        ).toISOString(),
        now: new Date(failedAtMs).toISOString(),
      })
      summary[outcome] += 1
    }
  }
  return summary
}
