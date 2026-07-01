import { afterEach, describe, expect, test } from "bun:test"
import type { Env } from "../../../src/types"
import {
  abortMultipartUpload,
  buildUploadPartPresignedUrl,
  completeMultipartUpload,
  createMultipartUpload,
  fetchFilebaseWithTimeout,
  headObject,
  listParts,
} from "../../../src/lib/storage/filebase-multipart"
import { HttpError } from "../../../src/lib/errors"
import { mockFetch } from "../../helpers"

const env = {
  FILEBASE_S3_ACCESS_KEY: "AKIAIOSFODNN7EXAMPLE",
  FILEBASE_S3_SECRET_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  FILEBASE_MEDIA_BUCKET: "example-bucket",
  FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
  FILEBASE_S3_REGION: "us-east-1",
} as Env

const originalFetch = globalThis.fetch

function installFetch(handler: (request: Request) => Response | Promise<Response>): Request[] {
  const requests: Request[] = []
  globalThis.fetch = mockFetch(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push(request)
    return await handler(request)
  })
  return requests
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("filebase multipart helpers", () => {
  test("aborts timed out Filebase requests", async () => {
    let observedAbort = false
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          observedAbort = true
          reject(new DOMException("The operation was aborted.", "AbortError"))
        }, { once: true })
      })
    }

    await expect(fetchFilebaseWithTimeout(
      new Request("https://s3.filebase.test/example-bucket/object"),
      "Filebase test request",
      1,
    )).rejects.toThrow("Filebase test request timed out")
    expect(observedAbort).toBe(true)
  })

  test("creates a multipart upload and extracts UploadId", async () => {
    const requests = installFetch(() => new Response(
      "<InitiateMultipartUploadResult><UploadId>upload-123</UploadId></InitiateMultipartUploadResult>",
      { status: 200 },
    ))

    const result = await createMultipartUpload({
      env,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
      mimeType: "video/mp4",
    })

    expect(result.uploadId).toBe("upload-123")
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe("https://s3.filebase.test/example-bucket/song-artifacts/com_test/primary_video/sau_test.mp4?uploads=")
    expect(requests[0]?.headers.get("content-type")).toBe("video/mp4")
  })

  test("surfaces multipart init provider errors", async () => {
    installFetch(() => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }))

    await expect(createMultipartUpload({
      env,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
      mimeType: "video/mp4",
    })).rejects.toThrow("Filebase multipart init failed with status 403")
  })

  test("reads object metadata from HEAD", async () => {
    installFetch(() => new Response(null, {
      status: 200,
      headers: {
        "content-length": "6291456",
        "content-type": "video/mp4",
        etag: "\"multipart-etag\"",
        "x-amz-meta-cid": "QmHeadCid",
      },
    }))

    const result = await headObject({
      env,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
    })

    expect(result).toEqual({
      contentLength: 6291456,
      contentType: "video/mp4",
      etag: "\"multipart-etag\"",
      cid: "QmHeadCid",
    })
  })

  test("maps missing objects to not_found", async () => {
    installFetch(() => new Response(null, { status: 404 }))

    try {
      await headObject({ env, objectKey: "missing.mp4" })
      throw new Error("expected headObject to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).status).toBe(404)
      expect((error as HttpError).code).toBe("not_found")
    }
  })

  test("completes multipart upload and extracts ETag and CID", async () => {
    const requests = installFetch(() => new Response(
      "<CompleteMultipartUploadResult><ETag>&#34;abc-2&#34;</ETag><CID>QmCompleteCid</CID></CompleteMultipartUploadResult>",
      { status: 200 },
    ))

    const result = await completeMultipartUpload({
      env,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
      uploadId: "upload-123",
      parts: [
        { partNumber: 1, etag: "\"etag-1\"" },
        { partNumber: 2, etag: "\"etag-2\"" },
      ],
    })

    expect(result).toEqual({
      etag: "\"abc-2\"",
      cid: "QmCompleteCid",
    })
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe("https://s3.filebase.test/example-bucket/song-artifacts/com_test/primary_video/sau_test.mp4?uploadId=upload-123")
    expect(requests[0] ? await requests[0].text() : "").toBe(
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>\"etag-1\"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>\"etag-2\"</ETag></Part></CompleteMultipartUpload>",
    )
  })

  test("surfaces multipart complete provider errors", async () => {
    installFetch(() => new Response("<Error><Code>InvalidPart</Code></Error>", { status: 400 }))

    await expect(completeMultipartUpload({
      env,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
      uploadId: "upload-123",
      parts: [{ partNumber: 1, etag: "\"etag-1\"" }],
    })).rejects.toThrow("Filebase multipart complete failed with status 400")
  })

  test("aborts multipart uploads and tolerates 404", async () => {
    const requests = installFetch(() => new Response(null, { status: 404 }))

    await abortMultipartUpload({
      env,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
      uploadId: "upload-123",
    })

    expect(requests[0]?.method).toBe("DELETE")
    expect(requests[0]?.url).toBe("https://s3.filebase.test/example-bucket/song-artifacts/com_test/primary_video/sau_test.mp4?uploadId=upload-123")
  })

  test("warns but does not throw when abort fails", async () => {
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    try {
      installFetch(() => new Response("temporarily unavailable", { status: 503 }))

      await abortMultipartUpload({
        env,
        objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
        uploadId: "upload-123",
      })

      expect(warnings.length).toBe(1)
      expect(String(warnings[0]?.[0])).toBe("Filebase multipart abort failed")
    } finally {
      console.warn = originalWarn
    }
  })

  test("lists multipart parts and pagination state", async () => {
    const requests = installFetch(() => new Response(`
      <ListPartsResult>
        <IsTruncated>true</IsTruncated>
        <NextPartNumberMarker>5</NextPartNumberMarker>
        <Part><PartNumber>1</PartNumber><ETag>&#34;etag-1&#34;</ETag><Size>5242880</Size></Part>
        <Part><PartNumber>2</PartNumber><ETag>&#34;etag-2&#34;</ETag><Size>1048576</Size></Part>
      </ListPartsResult>
    `, { status: 200 }))

    const result = await listParts({
      env,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
      uploadId: "upload-123",
      partNumberMarker: 5,
      maxParts: 1000,
    })

    expect(new URL(requests[0]?.url ?? "").searchParams.get("part-number-marker")).toBe("5")
    expect(new URL(requests[0]?.url ?? "").searchParams.get("max-parts")).toBe("1000")
    expect(result).toEqual({
      parts: [
        { partNumber: 1, etag: "\"etag-1\"", size: 5242880 },
        { partNumber: 2, etag: "\"etag-2\"", size: 1048576 },
      ],
      isTruncated: true,
      nextPartNumberMarker: 5,
    })
  })

  test("builds presigned UploadPart URLs", async () => {
    const url = await buildUploadPartPresignedUrl({
      env,
      objectKey: "song-artifacts/com_test/primary_video/sau_test.mp4",
      uploadId: "upload-123",
      partNumber: 9,
      expiresInSeconds: 300,
      now: new Date("2026-06-05T12:34:56.000Z"),
    })

    expect(url.pathname).toBe("/example-bucket/song-artifacts/com_test/primary_video/sau_test.mp4")
    expect(url.searchParams.get("partNumber")).toBe("9")
    expect(url.searchParams.get("uploadId")).toBe("upload-123")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300")
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host")
    expect(url.searchParams.get("X-Amz-Signature")).toBe("1de52a3b1ed46e26fc3b196afef59a8580488a7de31327ce98402545ce7ee05b")
  })
})
