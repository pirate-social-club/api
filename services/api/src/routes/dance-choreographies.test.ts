import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Env } from "../env"
import { errorResponse } from "../lib/errors"
import { DANCE_CHOREOGRAPHY_SEED_SCOPE } from "../lib/operator-credential-auth"
import { signDanceGraderRequest } from "../lib/dance/grader-callback-auth"
import danceChoreographies, {
  setDanceChoreographyRouteServicesForTests,
} from "./dance-choreographies"

const dummyClient = {} as never
const env: Env = {
  DANCE_GRADER_CALLBACK_HMAC_KEY: "callback-secret-at-least-32-bytes",
  DANCE_GRADER_CALLBACK_KEY_VERSION: "v1",
}

function testApp() {
  const app = new Hono<{ Bindings: Env }>()
  app.route("/dance-choreographies", danceChoreographies)
  app.onError((error, c) => {
    const response = errorResponse(error)
    return c.json(response.body, response.status as 400)
  })
  return app
}

afterEach(() => {
  setDanceChoreographyRouteServicesForTests(null)
})

describe("dance choreography routes", () => {
  test("operator seed requires the dedicated scope and passes bounded facts", async () => {
    const calls: unknown[] = []
    setDanceChoreographyRouteServicesForTests({
      getControlPlaneClient: () => dummyClient,
      authenticateOperatorCredential: async () => ({
        authType: "operator_credential",
        operatorCredentialId: "opc_1",
        operatorActorId: "svc_1",
        scopes: [DANCE_CHOREOGRAPHY_SEED_SCOPE],
      }),
      seedOperatorDanceChoreography: async (input) => {
        calls.push(input.seed)
        return {
          kind: "created",
          record: {
            danceChoreographyId: "dch_1",
            danceChoreographyRevisionId: "dcr_1",
            choreographyStatus: "processing",
            revisionStatus: "processing",
            failureCode: null,
            referenceStorageRef: "references/dcr_1.mp4",
            referenceContentSha256: "c".repeat(64),
            referenceMimeType: "video/mp4",
            referenceSizeBytes: 4096,
            mirrorPolicy: "allowed",
            referenceFeatureRef: null,
            referenceDispatchAttemptCount: 0,
            referenceDispatchClaimToken: null,
            referenceDispatchId: null,
          },
        }
      },
      finalizeDanceChoreographyReference: async () => {
        throw new Error("not used")
      },
      now: () => Date.parse("2026-07-29T00:00:00.000Z"),
    })

    const response = await testApp().request(
      "http://test/dance-choreographies/operator/seed",
      {
        method: "POST",
        headers: {
          authorization: "Operator test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          dance_choreography_id: "dch_1",
          dance_choreography_revision_id: "dcr_1",
          community_id: "com_1",
          host_post_id: "post_dance",
          referenced_song_post_id: "post_song",
          song_artifact_bundle_id: "sab_1",
          creator_user_id: "usr_1",
          official: false,
          reference_storage_ref: "references/dcr_1.mp4",
          reference_content_sha256: "c".repeat(64),
          reference_mime_type: "video/mp4",
          reference_size_bytes: 4096,
          mirror_policy: "allowed",
        }),
      },
      env,
    )

    expect(response.status).toBe(201)
    expect(calls).toHaveLength(1)
    expect(await response.json()).toEqual({
      choreography: "dch_1",
      revision: "dcr_1",
      status: "processing",
      idempotent: false,
    })
  })

  test("verifies the signed raw callback body and binds subject to revision", async () => {
    const calls: unknown[] = []
    setDanceChoreographyRouteServicesForTests({
      getControlPlaneClient: () => dummyClient,
      authenticateOperatorCredential: async () => {
        throw new Error("not used")
      },
      seedOperatorDanceChoreography: async () => {
        throw new Error("not used")
      },
      finalizeDanceChoreographyReference: async (input) => {
        calls.push(input)
        return {
          kind: "finalized",
          record: {
            danceChoreographyId: "dch_1",
            danceChoreographyRevisionId: "dcr_1",
            choreographyStatus: "failed",
            revisionStatus: "failed",
            failureCode: "multiple_people",
            referenceStorageRef: "references/dcr_1.mp4",
            referenceContentSha256: "c".repeat(64),
            referenceMimeType: "video/mp4",
            referenceSizeBytes: 4096,
            mirrorPolicy: "allowed",
            referenceFeatureRef: null,
            referenceDispatchAttemptCount: 1,
            referenceDispatchClaimToken: null,
            referenceDispatchId: "fc-1",
          },
        }
      },
      now: () => 1_100_000,
    })
    const path = "/dance-choreographies/revisions/dcr_1/reference-callback"
    const body = Buffer.from(JSON.stringify({
      subject: "dcr_1",
      outcome: "failed",
      reason: "multiple_people",
    }))
    const signature = signDanceGraderRequest({
      key: "callback-secret-at-least-32-bytes",
      method: "POST",
      path,
      timestamp: 1000,
      subject: "dcr_1",
      body,
    })

    const response = await testApp().request(`http://test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dance-grader-key-version": "v1",
        "x-dance-grader-timestamp": "1000",
        "x-dance-grader-signature": signature,
      },
      body,
    }, env)

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(await response.json()).toEqual({
      revision: "dcr_1",
      status: "failed",
      idempotent: false,
      retryable: false,
    })
  })

  test("rejects a callback signed for another revision", async () => {
    setDanceChoreographyRouteServicesForTests({
      getControlPlaneClient: () => dummyClient,
      authenticateOperatorCredential: async () => {
        throw new Error("not used")
      },
      seedOperatorDanceChoreography: async () => {
        throw new Error("not used")
      },
      finalizeDanceChoreographyReference: async () => {
        throw new Error("must not finalize")
      },
      now: () => 1_100_000,
    })
    const body = JSON.stringify({
      subject: "dcr_other",
      outcome: "failed",
      reason: "multiple_people",
    })
    const response = await testApp().request(
      "http://test/dance-choreographies/revisions/dcr_1/reference-callback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
      env,
    )
    expect(response.status).toBe(400)
  })
})
