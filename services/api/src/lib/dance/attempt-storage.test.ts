import { describe, expect, test } from "bun:test"

import {
  buildDanceAttemptUploadIntent,
  deleteDanceAttemptUpload,
  DanceAttemptUploadInvalidError,
  danceAttemptObjectKey,
  verifyDanceAttemptUpload,
} from "./attempt-storage"

const env = {
  DANCE_ATTEMPT_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  DANCE_ATTEMPT_S3_ACCESS_KEY: "access",
  DANCE_ATTEMPT_S3_SECRET_KEY: "secret",
  DANCE_ATTEMPT_S3_BUCKET: "private-attempts",
  DANCE_ATTEMPT_S3_REGION: "auto",
} as never
const sha = "a".repeat(64)

describe("dance attempt private storage", () => {
  test("binds a single-object upload URL to session, hash, size, and MIME type", async () => {
    const result = await buildDanceAttemptUploadIntent({
      env,
      sessionId: "das_123",
      contentSha256: sha,
      sizeBytes: 1234,
      now: new Date("2026-07-30T00:00:00Z"),
    })
    expect(result.objectKey).toBe(`dance/attempt-media/das_123/${sha}.mp4`)
    expect(result.requiredHeaders).toEqual({
      "content-length": "1234",
      "content-type": "video/mp4",
      "x-amz-meta-content-sha256": sha,
    })
    const url = new URL(result.putUrl)
    expect(url.pathname).toBe(`/private-attempts/${result.objectKey}`)
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host;x-amz-meta-content-sha256",
    )
  })

  test("rejects unsafe object-key inputs", () => {
    expect(() => danceAttemptObjectKey("../session", sha)).toThrow()
    expect(() => danceAttemptObjectKey("das_123", "not-a-hash")).toThrow()
  })

  test("accepts HEAD only when all signed upload facts match", async () => {
    const result = await verifyDanceAttemptUpload({
      env,
      objectKey: `dance/attempt-media/das_123/${sha}.mp4`,
      expectedContentSha256: sha,
      expectedSizeBytes: 1234,
      now: new Date("2026-07-30T00:00:00Z"),
      fetchFn: async () => new Response(null, {
        status: 200,
        headers: {
          "content-length": "1234",
          "content-type": "video/mp4",
          "etag": "\"etag\"",
          "x-amz-meta-content-sha256": sha,
        },
      }),
    })
    expect(result).toEqual({ etag: "\"etag\"" })
  })

  test("rejects mismatched HEAD metadata before dispatch", async () => {
    await expect(verifyDanceAttemptUpload({
      env,
      objectKey: `dance/attempt-media/das_123/${sha}.mp4`,
      expectedContentSha256: sha,
      expectedSizeBytes: 1234,
      fetchFn: async () => new Response(null, {
        status: 200,
        headers: {
          "content-length": "1235",
          "content-type": "video/mp4",
          "etag": "\"etag\"",
          "x-amz-meta-content-sha256": sha,
        },
      }),
    })).rejects.toBeInstanceOf(DanceAttemptUploadInvalidError)
  })

  test("treats deletion and an already-missing object as successful", async () => {
    for (const status of [204, 404]) {
      let method = ""
      await deleteDanceAttemptUpload({
        env,
        objectKey: `dance/attempt-media/das_123/${sha}.mp4`,
        now: new Date("2026-07-30T00:00:00Z"),
        fetchFn: async (input) => {
          method = new Request(input).method
          return new Response(null, { status })
        },
      })
      expect(method).toBe("DELETE")
    }
  })
})
