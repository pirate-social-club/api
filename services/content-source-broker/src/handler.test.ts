import { describe, expect, test } from "bun:test"
import {
  CONTENT_SOURCE_STORAGE_NAMESPACE,
  handleContentSourceBrokerRequest,
  type ContentSourceBrokerEnv,
} from "./handler"

const BROKER_SECRET = "broker-fixture-secret"
const SCANNER_SECRET = "scanner-fixture-secret"
const BLOB_ID = "cbl_fixture"

type StoredObject = {
  bytes: Uint8Array
  customMetadata: Record<string, string>
  sha256: ArrayBuffer
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function r2Object(key: string, stored: StoredObject): R2Object {
  return {
    key,
    version: "fixture-version",
    size: stored.bytes.byteLength,
    etag: "fixture-etag",
    httpEtag: '"fixture-etag"',
    uploaded: new Date("2026-08-12T00:00:00Z"),
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: stored.customMetadata,
    range: { offset: 0, length: stored.bytes.byteLength },
    checksums: {
      sha256: stored.sha256,
      toJSON: () => ({ sha256: hex(stored.sha256) }),
    },
    storageClass: "Standard",
    writeHttpMetadata: () => undefined,
  }
}

function fakeR2(): { bucket: R2Bucket; objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>()
  const bucket = {
    async head(key: string) {
      const stored = objects.get(key)
      return stored ? r2Object(key, stored) : null
    },
    async get(key: string) {
      const stored = objects.get(key)
      if (!stored) return null
      return {
        ...r2Object(key, stored),
        body: new Blob([stored.bytes]).stream(),
        bodyUsed: false,
        arrayBuffer: async () => stored.bytes.buffer,
        text: async () => new TextDecoder().decode(stored.bytes),
        json: async <T>() => JSON.parse(new TextDecoder().decode(stored.bytes)) as T,
        blob: async () => new Blob([stored.bytes]),
      }
    },
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options?: R2PutOptions,
    ) {
      if (objects.has(key) && (options?.onlyIf as R2Conditional | undefined)?.etagDoesNotMatch === "*") {
        return null
      }
      const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer())
      const actualSha256 = await crypto.subtle.digest("SHA-256", bytes)
      const expectedSha256 = options?.sha256 instanceof ArrayBuffer
        ? options.sha256
        : ArrayBuffer.isView(options?.sha256)
          ? options.sha256.buffer
          : null
      if (!expectedSha256 || hex(actualSha256) !== hex(expectedSha256)) {
        throw new Error("checksum mismatch")
      }
      const stored = {
        bytes,
        customMetadata: options?.customMetadata ?? {},
        sha256: actualSha256,
      }
      objects.set(key, stored)
      return r2Object(key, stored)
    },
    async delete(key: string) {
      objects.delete(key)
    },
  } as unknown as R2Bucket
  return { bucket, objects }
}

function env(options: {
  bucket?: R2Bucket
  scanner?: (request: Request) => Promise<Response>
} = {}): ContentSourceBrokerEnv {
  return {
    ENVIRONMENT: "test",
    CONTENT_SOURCE_OBJECTS: options.bucket ?? fakeR2().bucket,
    CONTENT_SOURCE_BROKER_SHARED_SECRET: BROKER_SECRET,
    CONTENT_MALWARE_SCANNER_SHARED_SECRET: SCANNER_SECRET,
    CONTENT_MALWARE_SCANNER_SERVICE: {
      fetch: options.scanner ?? (async () => Response.json({ outcome: "clean" })),
      connect: () => { throw new Error("not implemented") },
    },
  }
}

async function digest(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes))
}

function requestHeaders(sha256: string, sizeBytes: number): Record<string, string> {
  return {
    authorization: `Bearer ${BROKER_SECRET}`,
    "content-type": "application/octet-stream",
    "content-length": String(sizeBytes),
    "x-content-sha256": sha256,
    "x-content-size": String(sizeBytes),
  }
}

describe("content source broker", () => {
  test("rejects unauthenticated object access without touching R2", async () => {
    const { bucket, objects } = fakeR2()
    const response = await handleContentSourceBrokerRequest(
      new Request(`https://broker.test/objects/${BLOB_ID}`, { method: "HEAD" }),
      env({ bucket }),
    )
    expect(response.status).toBe(401)
    expect(objects.size).toBe(0)
  })

  test("treats malformed encoded object identifiers as not found", async () => {
    const response = await handleContentSourceBrokerRequest(new Request(
      "https://broker.test/objects/%ZZ",
      { headers: { authorization: `Bearer ${BROKER_SECRET}` } },
    ), env({ bucket: fakeR2().bucket }))
    expect(response.status).toBe(404)
  })

  test("stores checksum-bound bytes and treats the same write as idempotent", async () => {
    const { bucket, objects } = fakeR2()
    const bytes = new TextEncoder().encode("word,meaning\nship,vessel\n")
    const sha256 = await digest(bytes)
    const store = () => handleContentSourceBrokerRequest(new Request(
      `https://broker.test/objects/${BLOB_ID}`,
      { method: "PUT", headers: requestHeaders(sha256, bytes.byteLength), body: bytes },
    ), env({ bucket }))

    const first = await store()
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual(expect.objectContaining({
      object: "content_source_object",
      content_blob: BLOB_ID,
      status: "stored",
      content_sha256: sha256,
      size_bytes: bytes.byteLength,
    }))
    const second = await store()
    expect(second.status).toBe(200)
    expect(objects.size).toBe(1)
    expect(objects.has(`${CONTENT_SOURCE_STORAGE_NAMESPACE}/${BLOB_ID}`)).toBe(true)
  })

  test("rejects a conflicting write for the same blob", async () => {
    const { bucket } = fakeR2()
    const firstBytes = new TextEncoder().encode("first")
    const firstHash = await digest(firstBytes)
    await handleContentSourceBrokerRequest(new Request(
      `https://broker.test/objects/${BLOB_ID}`,
      { method: "PUT", headers: requestHeaders(firstHash, firstBytes.byteLength), body: firstBytes },
    ), env({ bucket }))

    const secondBytes = new TextEncoder().encode("second")
    const secondHash = await digest(secondBytes)
    const response = await handleContentSourceBrokerRequest(new Request(
      `https://broker.test/objects/${BLOB_ID}`,
      { method: "PUT", headers: requestHeaders(secondHash, secondBytes.byteLength), body: secondBytes },
    ), env({ bucket }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({ code: "source_conflict" }))
  })

  test("streams one verified object to the scanner with job-bound metadata", async () => {
    const { bucket } = fakeR2()
    const bytes = new TextEncoder().encode("verified source")
    const sha256 = await digest(bytes)
    await handleContentSourceBrokerRequest(new Request(
      `https://broker.test/objects/${BLOB_ID}`,
      { method: "PUT", headers: requestHeaders(sha256, bytes.byteLength), body: bytes },
    ), env({ bucket }))

    let scannerCalls = 0
    const response = await handleContentSourceBrokerRequest(new Request(
      `https://broker.test/objects/${BLOB_ID}/scan`,
      {
        method: "POST",
        headers: {
          ...requestHeaders(sha256, bytes.byteLength),
          "x-content-scan-job": "csj_fixture",
        },
      },
    ), env({
      bucket,
      scanner: async (request) => {
        scannerCalls += 1
        expect(request.headers.get("authorization")).toBe(`Bearer ${SCANNER_SECRET}`)
        expect(request.headers.get("x-content-scan-job")).toBe("csj_fixture")
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes)
        return Response.json({
          object: "content_malware_scan",
          job: "csj_fixture",
          content_sha256: sha256,
          size_bytes: bytes.byteLength,
          outcome: "clean",
        })
      },
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get("x-content-source-bytes-read")).toBe(String(bytes.byteLength))
    expect(scannerCalls).toBe(1)
  })

  test("fails closed before scanning when expected metadata does not match", async () => {
    const { bucket } = fakeR2()
    const bytes = new TextEncoder().encode("verified source")
    const sha256 = await digest(bytes)
    await handleContentSourceBrokerRequest(new Request(
      `https://broker.test/objects/${BLOB_ID}`,
      { method: "PUT", headers: requestHeaders(sha256, bytes.byteLength), body: bytes },
    ), env({ bucket }))

    let scannerCalls = 0
    const response = await handleContentSourceBrokerRequest(new Request(
      `https://broker.test/objects/${BLOB_ID}/scan`,
      {
        method: "POST",
        headers: {
          ...requestHeaders("0".repeat(64), bytes.byteLength),
          "x-content-scan-job": "csj_fixture",
        },
      },
    ), env({
      bucket,
      scanner: async () => {
        scannerCalls += 1
        return Response.json({ outcome: "clean" })
      },
    }))
    expect(response.status).toBe(409)
    expect(scannerCalls).toBe(0)
  })

  test("deletes only the exact hash-bound object and confirms absence", async () => {
    const { bucket, objects } = fakeR2()
    const bytes = new TextEncoder().encode("delete source")
    const sha256 = await digest(bytes)
    await handleContentSourceBrokerRequest(new Request(
      `https://broker.test/objects/${BLOB_ID}`,
      { method: "PUT", headers: requestHeaders(sha256, bytes.byteLength), body: bytes },
    ), env({ bucket }))
    const response = await handleContentSourceBrokerRequest(new Request(
      `https://broker.test/objects/${BLOB_ID}`,
      { method: "DELETE", headers: requestHeaders(sha256, bytes.byteLength) },
    ), env({ bucket }))
    expect(response.status).toBe(204)
    expect(objects.size).toBe(0)
  })
})
