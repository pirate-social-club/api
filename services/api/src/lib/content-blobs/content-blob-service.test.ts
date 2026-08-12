import { describe, expect, test } from "bun:test"
import {
  CONTENT_BLOB_PROXY_MAX_BYTES,
  assertCreateContentBlobRequest,
} from "./content-blob-policy"
import { serializeContentBlob } from "./content-blob-serialization"
import type { OwnedContentBlob } from "./content-blob-types"

function ownedContentBlob(overrides?: Partial<OwnedContentBlob["blob"]>): OwnedContentBlob {
  return {
    blob: {
      content_blob_id: "cbl_fixture",
      community_id: "community_fixture",
      uploader_user_id: "user_fixture",
      status: "pending_upload",
      validation_profile: "download_file_v1",
      declared_filename: "records.csv",
      declared_mime_type: "text/csv",
      declared_size_bytes: 12,
      declared_content_hash: null,
      detected_mime_type: null,
      verified_size_bytes: null,
      verified_content_hash: null,
      security_scan_state: "pending",
      security_scan_profile: null,
      scanner_engine_version: null,
      scanner_signature_version: null,
      security_scan_result_ref: null,
      security_scanned_at: null,
      plaintext_retention_state: "active",
      plaintext_purged_at: null,
      storage_ref: "https://api.example/communities/community_fixture/content-blobs/cbl_fixture/content",
      storage_provider: null,
      storage_bucket: null,
      storage_object_key: null,
      storage_endpoint: null,
      gateway_url: null,
      ipfs_cid: null,
      rejection_code: null,
      claim_kind: null,
      claim_ref: null,
      claimed_at: null,
      created_at: "2026-08-12T00:00:00.000Z",
      updated_at: "2026-08-12T00:00:00.000Z",
      ...overrides,
    },
    uploadSession: {
      content_upload_session_id: "cus_fixture",
      content_blob_id: "cbl_fixture",
      uploader_user_id: "user_fixture",
      status: "created",
      upload_mode: "proxy",
      object_key: "content-source/v1/cbl_fixture",
      provider_upload_id: null,
      part_size_bytes: null,
      total_parts: null,
      bucket: "fixture-bucket",
      storage_endpoint: "https://s3.example",
      expires_at: "2026-08-12T01:00:00.000Z",
      created_at: "2026-08-12T00:00:00.000Z",
      updated_at: "2026-08-12T00:00:00.000Z",
      completed_at: null,
      aborted_at: null,
      aborted_reason: null,
    },
  }
}

describe("content blob request policy", () => {
  test("accepts the initial proxy profiles", () => {
    expect(() => assertCreateContentBlobRequest({
      validation_profile: "download_file_v1",
      declared_filename: "records.csv",
      declared_mime_type: "text/csv",
      declared_size_bytes: 12,
      upload_mode: "proxy",
    })).not.toThrow()

    expect(() => assertCreateContentBlobRequest({
      validation_profile: "deck_import_csv_v1",
      declared_mime_type: "text/csv",
      upload_mode: "proxy",
    })).not.toThrow()
  })

  test("rejects unknown policy profiles", () => {
    expect(() => assertCreateContentBlobRequest({
      validation_profile: "arbitrary_bytes_v1",
      declared_mime_type: "application/octet-stream",
      upload_mode: "proxy",
    })).toThrow("Unsupported validation_profile")
  })

  test("enforces the v1 MIME and filename-extension allowlist", () => {
    expect(() => assertCreateContentBlobRequest({
      validation_profile: "download_file_v1",
      declared_filename: "payload.exe",
      declared_mime_type: "application/octet-stream",
      upload_mode: "proxy",
    })).toThrow("does not accept declared_mime_type")

    expect(() => assertCreateContentBlobRequest({
      validation_profile: "download_file_v1",
      declared_filename: "payload.txt",
      declared_mime_type: "text/csv",
      upload_mode: "proxy",
    })).toThrow("declared_filename extension does not match")

    expect(() => assertCreateContentBlobRequest({
      validation_profile: "deck_import_csv_v1",
      declared_filename: "deck.json",
      declared_mime_type: "application/json",
      upload_mode: "proxy",
    })).toThrow("deck_import_csv_v1 requires text/csv")
  })

  test("rejects direct multipart until its public lifecycle routes exist", () => {
    expect(() => assertCreateContentBlobRequest({
      validation_profile: "download_file_v1",
      declared_mime_type: "text/csv",
      declared_size_bytes: 12,
      upload_mode: "direct_multipart",
    })).toThrow("direct_multipart content blobs are not enabled yet")
  })

  test("enforces the proxy byte ceiling at intent creation", () => {
    expect(() => assertCreateContentBlobRequest({
      validation_profile: "download_file_v1",
      declared_mime_type: "text/csv",
      declared_size_bytes: CONTENT_BLOB_PROXY_MAX_BYTES + 1,
      upload_mode: "proxy",
    })).toThrow("Proxy content blobs are limited to 50 MiB")
  })

  test("requires a canonical declared SHA-256 value", () => {
    expect(() => assertCreateContentBlobRequest({
      validation_profile: "download_file_v1",
      declared_mime_type: "text/csv",
      declared_content_hash: "abc",
      upload_mode: "proxy",
    })).toThrow("declared_content_hash must be a SHA-256 hex digest")
  })
})

describe("content blob serialization", () => {
  test("exposes proxy upload state without storage credentials", () => {
    const serialized = serializeContentBlob(ownedContentBlob())
    expect(serialized).toEqual({
      id: "cbl_fixture",
      object: "content_blob",
      community: "com_community_fixture",
      uploader_user: "usr_user_fixture",
      status: "pending_upload",
      validation_profile: "download_file_v1",
      declared_filename: "records.csv",
      declared_mime_type: "text/csv",
      declared_size_bytes: 12,
      declared_content_hash: null,
      detected_mime_type: null,
      verified_size_bytes: null,
      verified_content_hash: null,
      security_scan_state: "pending",
      rejection_code: null,
      plaintext_retention_state: "active",
      upload_url: "https://api.example/communities/community_fixture/content-blobs/cbl_fixture/content",
      upload_session: {
        id: "cus_fixture",
        status: "created",
        upload_mode: "proxy",
        provider_upload_id: null,
        part_size_bytes: null,
        total_parts: null,
        expires_at: 1786496400,
        sign_part_url: null,
        complete_url: null,
        abort_url: null,
      },
      created: 1786492800,
    })
    expect(JSON.stringify(serialized)).not.toContain("fixture-bucket")
    expect(JSON.stringify(serialized)).not.toContain("s3.example")
  })

  test("removes the upload URL once bytes are uploaded for scanning", () => {
    const owned = ownedContentBlob({
      status: "uploaded",
      verified_size_bytes: 12,
      verified_content_hash: `0x${"a".repeat(64)}`,
    })
    if (owned.uploadSession) {
      owned.uploadSession.status = "uploaded"
      owned.uploadSession.completed_at = "2026-08-12T00:01:00.000Z"
    }
    const serialized = serializeContentBlob(owned)
    expect(serialized.status).toBe("uploaded")
    expect(serialized.security_scan_state).toBe("pending")
    expect(serialized.upload_url).toBeNull()
  })
})
