import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Env } from "../env"
import openApiSpec from "../generated/openapi-spec"
import { serializeDanceSession } from "../lib/dance/dance-read-service"
import { errorResponse } from "../lib/errors"
import danceSessions, {
  danceCancellationResponse,
  danceSessionCreateResponse,
  danceSubmissionResponse,
  danceUploadIntentResponse,
} from "./dance-sessions"

const env: Env = { DANCE_CAPTURE_ENABLED: "true" }

type ContractSchema = {
  $ref?: string
  required?: string[]
  allOf?: ContractSchema[]
}

const danceSchemas = openApiSpec.components.schemas as unknown as Record<
  string,
  ContractSchema
>

function requiredContractFields(schemaName: string): string[] {
  const collect = (schema: ContractSchema): string[] => {
    if (schema.$ref) {
      const name = schema.$ref.split("/").at(-1)
      if (!name || !danceSchemas[name]) throw new Error(`Missing schema ${schema.$ref}`)
      return collect(danceSchemas[name])
    }
    return [
      ...(schema.required ?? []),
      ...(schema.allOf ?? []).flatMap(collect),
    ]
  }
  const schema = danceSchemas[schemaName]
  if (!schema) throw new Error(`Missing schema ${schemaName}`)
  return [...new Set(collect(schema))]
}

function expectRequiredContractFields(
  schemaName: string,
  response: Record<string, unknown>,
): void {
  expect(Object.keys(response).sort()).toEqual(
    requiredContractFields(schemaName).sort(),
  )
}

function app() {
  const value = new Hono<{ Bindings: Env }>()
  value.route("/dance-sessions", danceSessions)
  value.onError((error, c) => {
    const response = errorResponse(error)
    return c.json(response.body, response.status as 400)
  })
  return value
}

describe("dance session routes", () => {
  test("requires authentication for session reads", async () => {
    const response = await app().request(
      "http://test/dance-sessions/dse_1",
      {},
      env,
    )
    expect(response.status).toBe(401)
  })

  test("requires authentication for cancellation", async () => {
    const response = await app().request(
      "http://test/dance-sessions/dse_1/cancel",
      { method: "POST" },
      env,
    )
    expect(response.status).toBe(401)
  })

  test("reports whether cancellation was idempotent", () => {
    const response = danceCancellationResponse({
      sessionId: "dse_1",
      attemptId: "dat_1",
      subjectUserId: "usr_1",
      communityId: "cmty_1",
      hostPostId: "1",
      referencedSongPostId: "post_song",
      choreographyId: "dch_1",
      choreographyRevisionId: "dcr_1",
      status: "cancelled",
      uploadObjectKey: "dance/attempt-media/dse_1/pending.mp4",
      maximumBytes: 1024,
      observedSizeBytes: null,
      observedEtag: null,
      observedContentSha256: null,
      terminalReason: "cancelled",
      scoreBps: null,
      calibrationAdmitted: null,
      consentPolicyVersion: "dance_recording_v1",
      consentedAt: "2026-08-10T00:00:00.000Z",
      consentSource: "api",
      expiresAt: "2026-08-10T00:30:00.000Z",
      submittedAt: null,
      finalizedAt: "2026-08-10T00:01:00.000Z",
      createdAt: "2026-08-10T00:00:00.000Z",
    }, true)

    expect(response).toMatchObject({ status: "cancelled", idempotent: true })
  })

  test("includes created and idempotency in create responses", () => {
    const response = danceSessionCreateResponse({
      sessionId: "dse_1",
      attemptId: "dat_1",
      subjectUserId: "usr_1",
      communityId: "cmty_1",
      hostPostId: "1",
      referencedSongPostId: "post_song",
      choreographyId: "dch_1",
      choreographyRevisionId: "dcr_1",
      status: "initialized",
      uploadObjectKey: "dance/attempt-media/dse_1/pending.mp4",
      maximumBytes: 1024,
      observedSizeBytes: null,
      observedEtag: null,
      observedContentSha256: null,
      terminalReason: null,
      scoreBps: null,
      calibrationAdmitted: null,
      consentPolicyVersion: "dance_recording_v1",
      consentedAt: "2026-08-10T00:00:00.000Z",
      consentSource: "api",
      expiresAt: "2026-08-10T00:30:00.000Z",
      submittedAt: null,
      finalizedAt: null,
      createdAt: "2026-08-10T00:00:00.000Z",
    }, false)

    expect(response).toMatchObject({
      status: "initialized",
      created: 1_786_320_000,
      idempotent: false,
    })
  })

  test("dance response serializers match canonical required fields", () => {
    const uploadIntent = danceUploadIntentResponse({
      sessionId: "dse_1",
      putUrl: "https://upload.invalid/object",
      requiredHeaders: { "content-type": "video/mp4" },
      expiresAt: 1_786_321_800,
      idempotent: false,
    })
    const record = {
      sessionId: "dse_1",
      attemptId: "dat_1",
      subjectUserId: "usr_1",
      communityId: "cmty_1",
      hostPostId: "1",
      referencedSongPostId: "post_song",
      choreographyId: "dch_1",
      choreographyRevisionId: "dcr_1",
      status: "submitted",
      uploadObjectKey: "dance/attempt-media/dse_1/object.mp4",
      maximumBytes: 1024,
      observedSizeBytes: 1024,
      observedEtag: "etag",
      observedContentSha256: "a".repeat(64),
      terminalReason: null,
      scoreBps: null,
      calibrationAdmitted: null,
      consentPolicyVersion: "dance_recording_v1",
      consentedAt: "2026-08-10T00:00:00.000Z",
      consentSource: "api",
      expiresAt: "2026-08-10T00:30:00.000Z",
      submittedAt: "2026-08-10T00:01:00.000Z",
      finalizedAt: null,
      createdAt: "2026-08-10T00:00:00.000Z",
    }
    const session = serializeDanceSession(record)
    const mutation = danceSessionCreateResponse(record, false)
    const submission = danceSubmissionResponse(record, false)

    expectRequiredContractFields("DanceSession", session)
    expectRequiredContractFields("DanceSessionMutationResponse", mutation)
    expectRequiredContractFields("DanceSessionUploadIntent", uploadIntent)
    expectRequiredContractFields("DanceSessionSubmission", submission)
  })
})
