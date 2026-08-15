import { describe, expect, test } from "bun:test"
import { claimOwnedReadyContentBlob, releaseOwnedContentBlobClaim } from "./content-blob-repository"
import type { ContentBlobRow } from "./content-blob-types"
import type { Client } from "../sql-client"

function row(overrides: Partial<ContentBlobRow> = {}): Record<string, unknown> {
  return {
    content_blob_id: "cbl_1",
    community_id: "com_1",
    uploader_user_id: "usr_1",
    status: "ready",
    validation_profile: "download_file_v1",
    declared_filename: "records.csv",
    declared_mime_type: "text/csv",
    declared_size_bytes: 12,
    declared_content_hash: null,
    detected_mime_type: "text/csv",
    verified_size_bytes: 12,
    verified_content_hash: "a".repeat(64),
    security_scan_state: "clean",
    security_scan_profile: "download_file_v1",
    scanner_engine_version: "scanner-1",
    scanner_signature_version: "sig-1",
    security_scan_result_ref: "scan_1",
    security_scanned_at: "2026-08-14T00:00:00.000Z",
    plaintext_retention_state: "active",
    plaintext_purged_at: null,
    storage_ref: "https://api.example/blob/cbl_1",
    storage_provider: "r2",
    storage_bucket: "content",
    storage_object_key: "content-source/v1/cbl_1",
    storage_endpoint: "https://r2.example",
    gateway_url: null,
    ipfs_cid: null,
    rejection_code: null,
    claim_kind: null,
    claim_ref: null,
    claimed_at: null,
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
    content_upload_session_id: "cus_1",
    upload_session_status: "uploaded",
    upload_mode: "proxy",
    object_key: "content-source/v1/cbl_1",
    provider_upload_id: null,
    part_size_bytes: null,
    total_parts: null,
    bucket: "content",
    expires_at: "2026-08-15T00:00:00.000Z",
    session_created_at: "2026-08-14T00:00:00.000Z",
    session_updated_at: "2026-08-14T00:00:00.000Z",
    completed_at: "2026-08-14T00:00:00.000Z",
    aborted_at: null,
    aborted_reason: null,
    ...overrides,
  }
}

function clientFor(initial: Record<string, unknown>): { client: Client; current: Record<string, unknown>; updates: number } {
  const current = { ...initial }
  let updates = 0
  const client = {
    execute: async (statement: { sql: string; args?: unknown[] }) => {
      if (/^\s*SELECT/i.test(statement.sql)) {
        if (statement.sql.includes("content_upload_sessions")) {
          return {
            rows: [{
              content_upload_session_id: current.content_upload_session_id,
              content_blob_id: current.content_blob_id,
              uploader_user_id: current.uploader_user_id,
              status: current.upload_session_status,
              upload_mode: current.upload_mode,
              object_key: current.object_key,
              provider_upload_id: current.provider_upload_id,
              part_size_bytes: current.part_size_bytes,
              total_parts: current.total_parts,
              bucket: current.bucket,
              storage_endpoint: current.storage_endpoint,
              expires_at: current.expires_at,
              created_at: current.session_created_at,
              updated_at: current.session_updated_at,
              completed_at: current.completed_at,
              aborted_at: current.aborted_at,
              aborted_reason: current.aborted_reason,
            }],
            rowsAffected: 0,
          }
        }
        return { rows: [current], rowsAffected: 0 }
      }
      updates += 1
      if (statement.sql.includes("claim_kind = NULL")) {
        if (
          current.claim_kind !== statement.args?.[4]
          || current.claim_ref !== statement.args?.[5]
        ) return { rows: [], rowsAffected: 0 }
        current.claim_kind = null
        current.claim_ref = null
        current.claimed_at = null
        current.updated_at = statement.args?.[0] ?? null
        return { rows: [], rowsAffected: 1 }
      }
      if (current.security_scan_state !== "clean") return { rows: [], rowsAffected: 0 }
      current.claim_kind = statement.args?.[0] ?? null
      current.claim_ref = statement.args?.[1] ?? null
      current.claimed_at = statement.args?.[2] ?? null
      current.updated_at = statement.args?.[2] ?? null
      return { rows: [], rowsAffected: 1 }
    },
  } as unknown as Client
  return { client, current, get updates() { return updates } }
}

describe("claimOwnedReadyContentBlob", () => {
  test("claims a clean ready blob with a conditional update", async () => {
    const state = clientFor(row())
    const claimed = await claimOwnedReadyContentBlob({
      client: state.client,
      communityId: "com_1",
      uploaderUserId: "usr_1",
      contentBlobId: "cbl_1",
      claimKind: "asset_payload",
      claimRef: "ast_1",
      claimedAt: "2026-08-14T01:00:00.000Z",
    })

    expect(claimed.blob.claim_kind).toBe("asset_payload")
    expect(claimed.blob.claim_ref).toBe("ast_1")
    expect(state.updates).toBe(1)
  })

  test("replaying the same claim is idempotent", async () => {
    const state = clientFor(row({ claim_kind: "asset_payload", claim_ref: "ast_1" }))
    const claimed = await claimOwnedReadyContentBlob({
      client: state.client,
      communityId: "com_1",
      uploaderUserId: "usr_1",
      contentBlobId: "cbl_1",
      claimKind: "asset_payload",
      claimRef: "ast_1",
      claimedAt: "2026-08-14T02:00:00.000Z",
    })

    expect(claimed.blob.claim_ref).toBe("ast_1")
    expect(state.updates).toBe(0)
  })

  test("rejects a blob that has not passed the scan gate", async () => {
    const state = clientFor(row({ security_scan_state: "malicious" }))
    await expect(claimOwnedReadyContentBlob({
      client: state.client,
      communityId: "com_1",
      uploaderUserId: "usr_1",
      contentBlobId: "cbl_1",
      claimKind: "asset_payload",
      claimRef: "ast_1",
      claimedAt: "2026-08-14T03:00:00.000Z",
    })).rejects.toThrow("not ready to claim")
    expect(state.updates).toBe(1)
  })

  test("does not let a same-claim retry bypass a later scan rejection", async () => {
    const state = clientFor(row({
      claim_kind: "asset_payload",
      claim_ref: "ast_1",
      security_scan_state: "malicious",
    }))
    await expect(claimOwnedReadyContentBlob({
      client: state.client,
      communityId: "com_1",
      uploaderUserId: "usr_1",
      contentBlobId: "cbl_1",
      claimKind: "asset_payload",
      claimRef: "ast_1",
      claimedAt: "2026-08-14T04:00:00.000Z",
    })).rejects.toThrow("no longer ready to claim")
    expect(state.updates).toBe(0)
  })

  test("releases only the exact claim reference for compensation", async () => {
    const state = clientFor(row({ claim_kind: "asset_payload", claim_ref: "ast_1" }))
    await releaseOwnedContentBlobClaim({
      client: state.client,
      communityId: "com_1",
      uploaderUserId: "usr_1",
      contentBlobId: "cbl_1",
      claimKind: "asset_payload",
      claimRef: "ast_1",
      releasedAt: "2026-08-14T05:00:00.000Z",
    })
    expect(state.current.claim_kind).toBeNull()
    expect(state.current.claim_ref).toBeNull()
  })
})
