import { describe, expect, test } from "bun:test"
import {
  buildS3PresignedUrl,
  buildS3SignedRequest,
  EMPTY_SHA256_HEX,
  S3_UNSIGNED_PAYLOAD,
  type S3SigningConfig,
} from "../../../src/lib/storage/s3-signing"
import { sha256Hex } from "../../../src/lib/crypto"

const config: S3SigningConfig = {
  accessKey: "AKIAIOSFODNN7EXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  bucket: "example-bucket",
  endpoint: new URL("https://s3.filebase.test"),
  region: "us-east-1",
}

const fixedNow = new Date("2026-06-05T12:34:56.000Z")

describe("s3 signing", () => {
  test("preserves header-signed object requests", async () => {
    const body = new TextEncoder().encode("hello")
    const payloadHash = await sha256Hex(body)
    const request = await buildS3SignedRequest({
      method: "PUT",
      config,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
      payloadHash,
      headers: {
        "content-type": "video/mp4",
      },
      body,
      now: fixedNow,
    })

    expect(request.method).toBe("PUT")
    expect(request.url).toBe("https://s3.filebase.test/example-bucket/song-artifacts/com_test/primary_video/sau_test.mp4")
    expect(request.headers.get("x-amz-date")).toBe("20260605T123456Z")
    expect(request.headers.get("x-amz-content-sha256")).toBe(payloadHash)
    expect(request.headers.get("content-type")).toBe("video/mp4")
    expect(request.headers.get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260605/us-east-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=77daf6b787d1af183a8213af28d78edc0ba5ee661465b78e7d640df914a1fa6d",
    )
  })

  test("signs POST requests with XML body hash", async () => {
    const body = "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>\"abc\"</ETag></Part></CompleteMultipartUpload>"
    const request = await buildS3SignedRequest({
      method: "POST",
      config,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
      query: {
        uploadId: "upload-test",
      },
      headers: {
        "content-type": "application/xml",
      },
      body,
      now: fixedNow,
    })

    expect(request.method).toBe("POST")
    expect(request.url).toBe("https://s3.filebase.test/example-bucket/song-artifacts/com_test/primary_video/sau_test.mp4?uploadId=upload-test")
    expect(request.headers.get("x-amz-content-sha256")).toBe(await sha256Hex(body))
    expect(request.headers.get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260605/us-east-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=ba1a8ebdf932bbe3b74b6733222b4a9b114280b76b763ea6525bc912b1d516fb",
    )
  })

  test("supports empty-body DELETE requests", async () => {
    const request = await buildS3SignedRequest({
      method: "DELETE",
      config,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
      query: {
        uploadId: "upload-test",
      },
      bodyHashMode: "empty",
      now: fixedNow,
    })

    expect(request.method).toBe("DELETE")
    expect(request.headers.get("x-amz-content-sha256")).toBe(EMPTY_SHA256_HEX)
    expect(request.headers.get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260605/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=47b6119857e3ac6f3b8a2ca3418ed71f7b79e85925de8316e253ddeb8beb3664",
    )
  })

  test("builds presigned UploadPart URLs with unsigned payload", async () => {
    const url = await buildS3PresignedUrl({
      method: "PUT",
      config,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
      query: {
        partNumber: "7",
        uploadId: "upload-test",
      },
      bodyHashMode: "unsigned",
      expiresInSeconds: 300,
      now: fixedNow,
    })

    expect(url.origin).toBe("https://s3.filebase.test")
    expect(url.pathname).toBe("/example-bucket/song-artifacts/com_test/primary_video/sau_test.mp4")
    expect(url.searchParams.get("partNumber")).toBe("7")
    expect(url.searchParams.get("uploadId")).toBe("upload-test")
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256")
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20260605/us-east-1/s3/aws4_request")
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260605T123456Z")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300")
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host")
    expect(url.search).not.toContain(S3_UNSIGNED_PAYLOAD)
    expect(url.searchParams.get("X-Amz-Signature")).toBe("b727c353c1da3531a8f301e1d74f407a65e1b221eaa9749812eb29af2378c60d")
  })

  test("supports every S3 method in header signing", async () => {
    for (const method of ["GET", "HEAD", "PUT", "POST", "DELETE"] as const) {
      const request = await buildS3SignedRequest({
        method,
        config,
        objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
        bodyHashMode: "empty",
        now: fixedNow,
      })

      expect(request.method).toBe(method)
    }
  })

  test("validates presigned URL expiry bounds", async () => {
    for (const expiresInSeconds of [0, -1, 604801]) {
      await expect(buildS3PresignedUrl({
        method: "PUT",
        config,
        objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
        bodyHashMode: "unsigned",
        expiresInSeconds,
        now: fixedNow,
      })).rejects.toThrow("S3 presigned URL expiry must be between 1 and 604800 seconds")
    }
  })
})
