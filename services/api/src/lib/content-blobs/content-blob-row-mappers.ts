import {
  numberOrNull,
  requiredString,
  rowValue,
  stringOrNull,
} from "../sql-row"
import type {
  ContentBlobPlaintextRetentionState,
  ContentBlobRow,
  ContentBlobSecurityScanState,
  ContentBlobStatus,
  ContentUploadMode,
  ContentUploadSessionRow,
  ContentUploadSessionStatus,
} from "./content-blob-types"

export const CONTENT_BLOB_COLUMNS = `
  content_blob_id, community_id, uploader_user_id, status, validation_profile,
  declared_filename, declared_mime_type, declared_size_bytes, declared_content_hash,
  detected_mime_type, verified_size_bytes, verified_content_hash, security_scan_state,
  security_scan_profile, scanner_engine_version, scanner_signature_version,
  security_scan_result_ref, security_scanned_at, plaintext_retention_state,
  plaintext_purged_at, storage_ref, storage_provider, storage_bucket,
  storage_object_key, storage_endpoint, gateway_url, ipfs_cid, rejection_code,
  claim_kind, claim_ref, claimed_at, created_at, updated_at
`

export const CONTENT_UPLOAD_SESSION_COLUMNS = `
  content_upload_session_id, content_blob_id, uploader_user_id, status, upload_mode,
  object_key, provider_upload_id, part_size_bytes, total_parts, bucket, storage_endpoint,
  expires_at, created_at, updated_at, completed_at, aborted_at, aborted_reason
`

export function toContentBlobRow(row: unknown): ContentBlobRow {
  return {
    content_blob_id: requiredString(row, "content_blob_id"),
    community_id: requiredString(row, "community_id"),
    uploader_user_id: requiredString(row, "uploader_user_id"),
    status: requiredString(row, "status") as ContentBlobStatus,
    validation_profile: requiredString(row, "validation_profile"),
    declared_filename: stringOrNull(rowValue(row, "declared_filename")),
    declared_mime_type: requiredString(row, "declared_mime_type"),
    declared_size_bytes: numberOrNull(rowValue(row, "declared_size_bytes")),
    declared_content_hash: stringOrNull(rowValue(row, "declared_content_hash")),
    detected_mime_type: stringOrNull(rowValue(row, "detected_mime_type")),
    verified_size_bytes: numberOrNull(rowValue(row, "verified_size_bytes")),
    verified_content_hash: stringOrNull(rowValue(row, "verified_content_hash")),
    security_scan_state: requiredString(row, "security_scan_state") as ContentBlobSecurityScanState,
    security_scan_profile: stringOrNull(rowValue(row, "security_scan_profile")),
    scanner_engine_version: stringOrNull(rowValue(row, "scanner_engine_version")),
    scanner_signature_version: stringOrNull(rowValue(row, "scanner_signature_version")),
    security_scan_result_ref: stringOrNull(rowValue(row, "security_scan_result_ref")),
    security_scanned_at: stringOrNull(rowValue(row, "security_scanned_at")),
    plaintext_retention_state: requiredString(row, "plaintext_retention_state") as ContentBlobPlaintextRetentionState,
    plaintext_purged_at: stringOrNull(rowValue(row, "plaintext_purged_at")),
    storage_ref: requiredString(row, "storage_ref"),
    storage_provider: stringOrNull(rowValue(row, "storage_provider")),
    storage_bucket: stringOrNull(rowValue(row, "storage_bucket")),
    storage_object_key: stringOrNull(rowValue(row, "storage_object_key")),
    storage_endpoint: stringOrNull(rowValue(row, "storage_endpoint")),
    gateway_url: stringOrNull(rowValue(row, "gateway_url")),
    ipfs_cid: stringOrNull(rowValue(row, "ipfs_cid")),
    rejection_code: stringOrNull(rowValue(row, "rejection_code")),
    claim_kind: stringOrNull(rowValue(row, "claim_kind")) as ContentBlobRow["claim_kind"],
    claim_ref: stringOrNull(rowValue(row, "claim_ref")),
    claimed_at: stringOrNull(rowValue(row, "claimed_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toContentUploadSessionRow(row: unknown): ContentUploadSessionRow {
  return {
    content_upload_session_id: requiredString(row, "content_upload_session_id"),
    content_blob_id: requiredString(row, "content_blob_id"),
    uploader_user_id: requiredString(row, "uploader_user_id"),
    status: requiredString(row, "status") as ContentUploadSessionStatus,
    upload_mode: requiredString(row, "upload_mode") as ContentUploadMode,
    object_key: requiredString(row, "object_key"),
    provider_upload_id: stringOrNull(rowValue(row, "provider_upload_id")),
    part_size_bytes: numberOrNull(rowValue(row, "part_size_bytes")),
    total_parts: numberOrNull(rowValue(row, "total_parts")),
    bucket: requiredString(row, "bucket"),
    storage_endpoint: requiredString(row, "storage_endpoint"),
    expires_at: requiredString(row, "expires_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
    completed_at: stringOrNull(rowValue(row, "completed_at")),
    aborted_at: stringOrNull(rowValue(row, "aborted_at")),
    aborted_reason: stringOrNull(rowValue(row, "aborted_reason")),
  }
}
