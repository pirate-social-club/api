import { describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import {
  CONTENT_SOURCE_STORAGE_ENDPOINT,
  CONTENT_SOURCE_STORAGE_NAMESPACE,
  CONTENT_SOURCE_STORAGE_PROVIDER,
  storeContentSource,
} from "./content-source-broker-client"

const bytes = new TextEncoder().encode("source bytes")
const sha256 = "a".repeat(64)

function env(fetcher: (request: Request) => Promise<Response>): Env {
  return {
    CONTENT_SOURCE_BROKER_SHARED_SECRET: "broker-secret",
    CONTENT_SOURCE_BROKER: {
      fetch: fetcher,
      connect: () => { throw new Error("not implemented") },
    },
  } as unknown as Env
}

describe("content source broker client", () => {
  test("fails closed when the service binding or secret is absent", async () => {
    await expect(storeContentSource({
      env: {} as Env,
      contentBlobId: "cbl_fixture",
      bytes,
      sha256,
    })).rejects.toMatchObject({ status: 502, retryable: true })
  })

  test("stores exact bytes and accepts only matching broker evidence", async () => {
    const result = await storeContentSource({
      env: env(async (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer broker-secret")
        expect(request.headers.get("x-content-sha256")).toBe(sha256)
        expect(request.headers.get("x-content-size")).toBe(String(bytes.byteLength))
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes)
        return Response.json({
          object: "content_source_object",
          content_blob: "cbl_fixture",
          status: "stored",
          storage_namespace: CONTENT_SOURCE_STORAGE_NAMESPACE,
          storage_object_key: `${CONTENT_SOURCE_STORAGE_NAMESPACE}/cbl_fixture`,
          size_bytes: bytes.byteLength,
          content_sha256: sha256,
        }, { status: 201 })
      }),
      contentBlobId: "cbl_fixture",
      bytes,
      sha256,
    })
    expect(result).toEqual({
      storageProvider: CONTENT_SOURCE_STORAGE_PROVIDER,
      storageBucket: CONTENT_SOURCE_STORAGE_NAMESPACE,
      storageObjectKey: `${CONTENT_SOURCE_STORAGE_NAMESPACE}/cbl_fixture`,
      storageEndpoint: CONTENT_SOURCE_STORAGE_ENDPOINT,
      contentHash: `0x${sha256}`,
    })
  })

  test("fails closed on mismatched broker evidence", async () => {
    await expect(storeContentSource({
      env: env(async () => Response.json({
        object: "content_source_object",
        content_blob: "cbl_different",
        status: "stored",
        storage_namespace: CONTENT_SOURCE_STORAGE_NAMESPACE,
        storage_object_key: `${CONTENT_SOURCE_STORAGE_NAMESPACE}/cbl_different`,
        size_bytes: bytes.byteLength,
        content_sha256: sha256,
      })),
      contentBlobId: "cbl_fixture",
      bytes,
      sha256,
    })).rejects.toThrow("invalid evidence")
  })

  test("distinguishes immutable object conflicts from transient service failure", async () => {
    await expect(storeContentSource({
      env: env(async () => Response.json({ code: "source_conflict" }, { status: 409 })),
      contentBlobId: "cbl_fixture",
      bytes,
      sha256,
    })).rejects.toMatchObject({ status: 409, retryable: false })

    await expect(storeContentSource({
      env: env(async () => Response.json({ code: "unavailable" }, { status: 503 })),
      contentBlobId: "cbl_fixture",
      bytes,
      sha256,
    })).rejects.toMatchObject({ status: 502, retryable: true })
  })
})
