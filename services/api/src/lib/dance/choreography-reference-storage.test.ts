import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import {
  assertDanceStorageObjectKey,
  buildDanceReferenceSignedUrls,
  danceReferenceFeatureStorageRef,
} from "./choreography-reference-storage"

const env = {
  FILEBASE_S3_ACCESS_KEY: "access",
  FILEBASE_S3_SECRET_KEY: "secret",
  FILEBASE_MEDIA_BUCKET: "media",
  FILEBASE_S3_ENDPOINT: "https://s3.filebase.com",
  FILEBASE_S3_REGION: "us-east-1",
} as Env

describe("dance choreography reference storage", () => {
  test("uses deterministic private feature keys and bounded presigned object URLs", async () => {
    const signed = await buildDanceReferenceSignedUrls({
      env,
      referenceStorageRef: "references/dcr_1.mp4",
      danceChoreographyRevisionId: "dcr_1",
      now: new Date("2026-07-29T00:00:00.000Z"),
    })

    expect(signed.artifactStorageRef).toBe("dance/reference-features/dcr_1.json")
    expect(new URL(signed.mediaGetUrl).pathname).toBe("/media/references/dcr_1.mp4")
    const put = new URL(signed.artifactPutUrl)
    expect(put.pathname).toBe("/media/dance/reference-features/dcr_1.json")
    expect(put.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type")
    expect(put.searchParams.get("X-Amz-Expires")).toBe("300")
  })

  test("rejects traversal and absolute object keys", () => {
    expect(() => assertDanceStorageObjectKey("../reference.mp4")).toThrow()
    expect(() => assertDanceStorageObjectKey("/reference.mp4")).toThrow()
    expect(() => assertDanceStorageObjectKey("https://example.com/reference.mp4")).toThrow()
    expect(danceReferenceFeatureStorageRef("dcr_1")).toBe(
      "dance/reference-features/dcr_1.json",
    )
  })
})
