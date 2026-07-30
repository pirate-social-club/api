import { createHash, createHmac } from "node:crypto"
import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import {
  isDanceReferenceDispatchConfigured,
  postDanceReferenceDispatch,
} from "./choreography-reference-dispatch"

describe("dance choreography reference dispatch", () => {
  test("stays inert unless every durable dispatch dependency is configured", () => {
    expect(isDanceReferenceDispatchConfigured({} as Env)).toBe(false)
    expect(isDanceReferenceDispatchConfigured({
      DANCE_GRADER_DISPATCH_URL: "https://grader.example.test/dispatch",
      DANCE_GRADER_DISPATCH_HMAC_KEY: "k".repeat(32),
      DANCE_GRADER_DISPATCH_KEY_VERSION: "v1",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.example.test",
      FILEBASE_S3_ACCESS_KEY: "access",
      FILEBASE_S3_SECRET_KEY: "secret",
      FILEBASE_MEDIA_BUCKET: "media",
      CONTROL_PLANE_DATABASE_URL: "postgres://control",
    } as Env)).toBe(true)
  })

  test("signs the exact raw body and accepts only a bounded dispatch id", async () => {
    const key = "dispatch-secret-that-is-at-least-32-bytes"
    const payload = { subject: "dcr_1", media_get_url: "https://signed.invalid/get" }
    let request: Request | null = null
    const result = await postDanceReferenceDispatch({
      fetchFn: async (input, init) => {
        request = new Request(input, init)
        return Response.json({ dispatch_id: "fc-123" })
      },
      endpoint: new URL("https://grader.example.test/extract-reference"),
      hmacKey: key,
      keyVersion: "v1",
      subject: "dcr_1",
      payload,
      nowSeconds: 1234,
    })

    expect(result).toEqual({ dispatch_id: "fc-123" })
    expect(request).not.toBeNull()
    const raw = await request!.text()
    const bodyHash = createHash("sha256").update(raw).digest("hex")
    const expected = createHmac("sha256", key)
      .update(`POST\n/extract-reference\n1234\ndcr_1\n${bodyHash}`)
      .digest("hex")
    expect(request!.headers.get("x-dance-grader-signature")).toBe(expected)
    expect(request!.headers.get("x-dance-grader-key-version")).toBe("v1")
    expect(raw).toBe(JSON.stringify(payload))
  })
})
