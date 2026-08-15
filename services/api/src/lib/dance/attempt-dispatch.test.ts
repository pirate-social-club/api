import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import { isDanceAttemptDispatchConfigured } from "./attempt-dispatch"

describe("dance attempt dispatch", () => {
  test("stays inert unless every dispatch and private-storage dependency is configured", () => {
    expect(isDanceAttemptDispatchConfigured({} as Env)).toBe(false)
    expect(isDanceAttemptDispatchConfigured({
      DANCE_GRADER_ATTEMPT_DISPATCH_URL:
        "https://grader.example.test/grade-attempt",
      DANCE_GRADER_DISPATCH_HMAC_KEY: "k".repeat(32),
      DANCE_GRADER_DISPATCH_KEY_VERSION: "v1",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.example.test",
      CONTROL_PLANE_DATABASE_URL: "postgres://control",
      DANCE_ATTEMPT_S3_ENDPOINT: "https://attempts.example.test",
      DANCE_ATTEMPT_S3_ACCESS_KEY: "attempt-access",
      DANCE_ATTEMPT_S3_SECRET_KEY: "attempt-secret",
      DANCE_ATTEMPT_S3_BUCKET: "attempts",
      FILEBASE_S3_ACCESS_KEY: "reference-access",
      FILEBASE_S3_SECRET_KEY: "reference-secret",
      FILEBASE_MEDIA_BUCKET: "reference",
      DANCE_GRADING_ENABLED: "true",
    } as Env)).toBe(true)
  })

  test("stays inert when grading is disabled despite complete configuration", () => {
    expect(isDanceAttemptDispatchConfigured({
      DANCE_GRADER_ATTEMPT_DISPATCH_URL: "https://grader.example.test/grade-attempt",
      DANCE_GRADER_DISPATCH_HMAC_KEY: "k".repeat(32),
      DANCE_GRADER_DISPATCH_KEY_VERSION: "v1",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.example.test",
      CONTROL_PLANE_DATABASE_URL: "postgres://control",
      DANCE_ATTEMPT_S3_ENDPOINT: "https://attempts.example.test",
      DANCE_ATTEMPT_S3_ACCESS_KEY: "attempt-access",
      DANCE_ATTEMPT_S3_SECRET_KEY: "attempt-secret",
      DANCE_ATTEMPT_S3_BUCKET: "attempts",
      FILEBASE_S3_ACCESS_KEY: "reference-access",
      FILEBASE_S3_SECRET_KEY: "reference-secret",
      FILEBASE_MEDIA_BUCKET: "reference",
      DANCE_GRADING_ENABLED: "false",
    } as Env)).toBe(false)
  })

  test("rejects non-HTTPS grader and callback origins", () => {
    const configured = {
      DANCE_GRADER_ATTEMPT_DISPATCH_URL: "http://grader.test/grade-attempt",
      DANCE_GRADER_DISPATCH_HMAC_KEY: "k".repeat(32),
      DANCE_GRADER_DISPATCH_KEY_VERSION: "v1",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.example.test",
      CONTROL_PLANE_DATABASE_URL: "postgres://control",
      DANCE_ATTEMPT_S3_ENDPOINT: "https://attempts.example.test",
      DANCE_ATTEMPT_S3_ACCESS_KEY: "attempt-access",
      DANCE_ATTEMPT_S3_SECRET_KEY: "attempt-secret",
      DANCE_ATTEMPT_S3_BUCKET: "attempts",
      FILEBASE_S3_ACCESS_KEY: "reference-access",
      FILEBASE_S3_SECRET_KEY: "reference-secret",
      FILEBASE_MEDIA_BUCKET: "reference",
      DANCE_GRADING_ENABLED: "true",
    } as Env
    expect(isDanceAttemptDispatchConfigured(configured)).toBe(false)
  })
})
