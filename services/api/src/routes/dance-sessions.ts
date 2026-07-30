import { Hono } from "hono"

import {
  authenticate,
  type AuthenticatedEnv,
} from "../lib/auth-middleware"
import {
  bindDanceAttemptUploadIntent,
  createDanceAttemptSession,
  DANCE_ATTEMPT_MAX_BYTES,
  getDanceAttemptSession,
  submitDanceAttemptSession,
} from "../lib/dance/attempt-session-repository"
import {
  buildDanceAttemptUploadIntent,
  danceAttemptObjectKey,
  DanceAttemptUploadInvalidError,
  verifyDanceAttemptUpload,
} from "../lib/dance/attempt-storage"
import {
  badRequestError,
  conflictError,
  HttpError,
  notFoundError,
} from "../lib/errors"
import { studyActivityDate, STUDY_FALLBACK_TIMEZONE } from "../lib/posts/post-study-streak-read-service"
import { decodePublicPostId } from "../lib/public-ids"
import { getControlPlaneClient } from "../lib/runtime-deps"

const SHA256 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SESSION_TTL_MS = 30 * 60_000

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestError("Request body is invalid")
  }
  return value as Record<string, unknown>
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  maximum = 200,
): string {
  const fieldValue = value[field]
  if (
    typeof fieldValue !== "string"
    || fieldValue.length === 0
    || fieldValue.length > maximum
  ) {
    throw badRequestError(`${field} is invalid`)
  }
  return fieldValue
}

function sizeField(value: Record<string, unknown>): number {
  const size = value.size_bytes
  if (
    !Number.isSafeInteger(size)
    || Number(size) < 1
    || Number(size) > DANCE_ATTEMPT_MAX_BYTES
  ) {
    throw badRequestError("size_bytes is invalid")
  }
  return Number(size)
}

function contentHash(value: Record<string, unknown>): string {
  const hash = stringField(value, "content_sha256", 64)
  if (!SHA256.test(hash)) throw badRequestError("content_sha256 is invalid")
  return hash
}

function idempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? ""
  if (!UUID.test(key)) throw badRequestError("Idempotency-Key must be a UUID")
  return key
}

function assertUnexpired(expiresAt: string, nowMs: number): void {
  if (Date.parse(expiresAt) <= nowMs) {
    throw conflictError("Dance session has expired")
  }
}

const danceSessions = new Hono<AuthenticatedEnv>()
danceSessions.use("*", authenticate)

danceSessions.post("/", async (c) => {
  const body = bodyRecord(await c.req.json().catch(() => null))
  const postId = decodePublicPostId(stringField(body, "post", 200))
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  const sessionId = `dse_${crypto.randomUUID().replaceAll("-", "")}`
  const attemptId = `dat_${crypto.randomUUID().replaceAll("-", "")}`
  const result = await createDanceAttemptSession({
    client: getControlPlaneClient(c.env),
    value: {
      sessionId,
      attemptId,
      subjectUserId: c.get("actor").userId,
      hostPostId: postId,
      creationIdempotencyKey: idempotencyKey(c.req.header("idempotency-key")),
      activityDate: studyActivityDate(now, STUDY_FALLBACK_TIMEZONE),
      activityTimezone: STUDY_FALLBACK_TIMEZONE,
      now,
      expiresAt: new Date(nowMs + SESSION_TTL_MS).toISOString(),
    },
  })
  return c.json({
    id: result.record.sessionId,
    object: "dance_session",
    attempt: result.record.attemptId,
    post: result.record.hostPostId,
    choreography_revision: result.record.choreographyRevisionId,
    status: result.record.status,
    max_bytes: DANCE_ATTEMPT_MAX_BYTES,
    expires_at: Math.floor(Date.parse(result.record.expiresAt) / 1000),
    idempotent: result.kind === "idempotent",
  }, result.kind === "created" ? 201 : 200)
})

danceSessions.post("/:sessionId/upload-intent", async (c) => {
  const body = bodyRecord(await c.req.json().catch(() => null))
  if (body.mime_type !== "video/mp4") {
    throw badRequestError("mime_type must be video/mp4")
  }
  const hash = contentHash(body)
  const sizeBytes = sizeField(body)
  const now = new Date()
  const sessionId = c.req.param("sessionId")
  const actor = c.get("actor")
  const existing = await getDanceAttemptSession({
    client: getControlPlaneClient(c.env),
    sessionId,
    subjectUserId: actor.userId,
  })
  if (!existing) throw notFoundError("Dance session not found")
  assertUnexpired(existing.expiresAt, now.getTime())
  const intent = await buildDanceAttemptUploadIntent({
    env: c.env,
    sessionId,
    contentSha256: hash,
    sizeBytes,
    now,
  })
  const bound = await bindDanceAttemptUploadIntent({
    client: getControlPlaneClient(c.env),
    sessionId,
    subjectUserId: actor.userId,
    objectKey: intent.objectKey,
    sizeBytes,
    now: now.toISOString(),
  })
  return c.json({
    id: sessionId,
    object: "dance_session_upload_intent",
    method: "PUT",
    url: intent.putUrl,
    headers: intent.requiredHeaders,
    expires_at: Math.floor(now.getTime() / 1000) + 300,
    idempotent: bound.kind === "idempotent",
  }, 200)
})

danceSessions.post("/:sessionId/submit", async (c) => {
  const body = bodyRecord(await c.req.json().catch(() => null))
  if (body.capture_mode !== "in_app_camera") {
    throw badRequestError("capture_mode must be in_app_camera")
  }
  const hash = contentHash(body)
  const sizeBytes = sizeField(body)
  const now = new Date()
  const sessionId = c.req.param("sessionId")
  const actor = c.get("actor")
  const client = getControlPlaneClient(c.env)
  const existing = await getDanceAttemptSession({
    client,
    sessionId,
    subjectUserId: actor.userId,
  })
  if (!existing) throw notFoundError("Dance session not found")
  assertUnexpired(existing.expiresAt, now.getTime())
  if (existing.uploadObjectKey !== danceAttemptObjectKey(sessionId, hash)) {
    throw new HttpError(422, "upload_invalid", "Upload does not match its intent")
  }
  let verified: { etag: string }
  try {
    verified = await verifyDanceAttemptUpload({
      env: c.env,
      objectKey: existing.uploadObjectKey,
      expectedContentSha256: hash,
      expectedSizeBytes: sizeBytes,
      now,
    })
  } catch (error) {
    if (error instanceof DanceAttemptUploadInvalidError) {
      throw new HttpError(422, "upload_invalid", error.message)
    }
    throw error
  }
  const submitted = await submitDanceAttemptSession({
    client,
    sessionId,
    subjectUserId: actor.userId,
    contentSha256: hash,
    sizeBytes,
    etag: verified.etag,
    now: now.toISOString(),
  })
  return c.json({
    id: sessionId,
    object: "dance_session",
    attempt: submitted.record.attemptId,
    status: submitted.record.status,
    idempotent: submitted.kind === "idempotent",
  }, 202)
})

export default danceSessions
