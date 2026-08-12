import { describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import type { ContentSecurityScanJob } from "../content-security/content-security-types"
import {
  ContentSourceScanError,
  CONTENT_SOURCE_STORAGE_ENDPOINT,
  CONTENT_SOURCE_STORAGE_NAMESPACE,
  CONTENT_SOURCE_STORAGE_PROVIDER,
  scanContentSource,
  storeContentSource,
} from "./content-source-broker-client"

const bytes = new TextEncoder().encode("source bytes")
const sha256 = "a".repeat(64)
const job: ContentSecurityScanJob = {
  scanJobId: "csj_fixture",
  contentBlobId: "cbl_fixture",
  scannerRelease: {
    scannerReleaseId: "csr_release",
    securityScanProfile: "clamav-text-v1",
    engineVersion: "1.5.4",
    signatureVersion: "fixture-signatures",
    signatureDate: "2026-08-12T00:00:00.000Z",
    engineImageDigest: `sha256:${"b".repeat(64)}`,
    definitionDigest: "c".repeat(64),
    deployedImageDigest: `sha256:${"d".repeat(64)}`,
  },
  scanSequence: 1,
  requestReason: "initial_upload",
  expectedContentHash: `0x${sha256}`,
  expectedSizeBytes: bytes.byteLength,
  validationProfile: "download_file_v1",
  declaredFilename: "records.csv",
  declaredMimeType: "text/csv",
  attemptCount: 1,
  maxAttempts: 4,
  leaseOwner: "worker-fixture",
}

function scannerResult(overrides: Record<string, unknown> = {}) {
  return {
    object: "content_malware_scan",
    job: job.scanJobId,
    content_sha256: sha256,
    size_bytes: bytes.byteLength,
    outcome: "clean",
    policy_version: "clamav-text-v1",
    engine: "clamav",
    engine_version: "1.5.4",
    signature_version: "fixture-signatures",
    signature_date: "2026-08-12T00:00:00.000Z",
    engine_image_digest: `sha256:${"b".repeat(64)}`,
    definition_digest: "c".repeat(64),
    finding: null,
    error_code: null,
    format_policy_version: "text-download-formats-v1",
    format_outcome: "allow",
    detected_mime_type: "text/csv",
    format_finding_code: null,
    format_error_code: null,
    duration_ms: 12,
    ...overrides,
  }
}

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

  test("requests a job-bound scan and returns bounded read evidence", async () => {
    const result = await scanContentSource({
      env: env(async (request) => {
        expect(request.url).toEndWith("/objects/cbl_fixture/scan")
        expect(request.headers.get("authorization")).toBe("Bearer broker-secret")
        expect(request.headers.get("x-content-scan-job")).toBe(job.scanJobId)
        expect(request.headers.get("x-content-sha256")).toBe(sha256)
        expect(request.headers.get("x-content-validation-profile")).toBe("download_file_v1")
        expect(request.headers.get("x-content-declared-mime-type")).toBe("text/csv")
        expect(Buffer.from(request.headers.get("x-content-declared-filename-base64url")!, "base64url").toString()).toBe("records.csv")
        return Response.json(scannerResult(), {
          headers: { "x-content-source-bytes-read": String(bytes.byteLength) },
        })
      }),
      job,
    })
    expect(result.result.outcome).toBe("clean")
    expect(result.result.formatOutcome).toBe("allow")
    expect(result.bytesRead).toBe(bytes.byteLength)
    expect(result.readOutcome).toBe("completed")
  })

  test("classifies broker failures without accepting unbounded evidence", async () => {
    await expect(scanContentSource({
      env: env(async () => Response.json({ code: "source_missing" }, { status: 404 })),
      job,
    })).rejects.toMatchObject({
      code: "source_missing",
      retryable: false,
      readOutcome: "source_missing",
    } satisfies Partial<ContentSourceScanError>)

    await expect(scanContentSource({
      env: env(async () => Response.json(scannerResult(), {
        headers: { "x-content-source-bytes-read": String(bytes.byteLength + 1) },
      })),
      job,
    })).rejects.toMatchObject({
      code: "invalid_bytes_read",
      retryable: false,
      readOutcome: "metadata_mismatch",
    } satisfies Partial<ContentSourceScanError>)
  })
})
