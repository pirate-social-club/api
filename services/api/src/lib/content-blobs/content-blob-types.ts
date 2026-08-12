export type ContentBlobStatus =
  | "pending_upload"
  | "uploaded"
  | "verifying"
  | "ready"
  | "rejected"
  | "failed"
  | "cancelled"

export type ContentBlobSecurityScanState =
  | "pending"
  | "clean"
  | "suspicious"
  | "malicious"
  | "error"
  | "not_required"

export type ContentBlobPlaintextRetentionState =
  | "active"
  | "purge_pending"
  | "purged"
  | "legal_hold"

export type ContentUploadSessionStatus =
  | "created"
  | "parts_uploading"
  | "completing"
  | "head_verifying"
  | "uploaded"
  | "aborting"
  | "aborted"

export type ContentUploadMode = "proxy" | "direct_multipart"

export type ContentBlobRow = {
  content_blob_id: string
  community_id: string
  uploader_user_id: string
  status: ContentBlobStatus
  validation_profile: string
  declared_filename: string | null
  declared_mime_type: string
  declared_size_bytes: number | null
  declared_content_hash: string | null
  detected_mime_type: string | null
  verified_size_bytes: number | null
  verified_content_hash: string | null
  security_scan_state: ContentBlobSecurityScanState
  security_scan_profile: string | null
  scanner_engine_version: string | null
  scanner_signature_version: string | null
  security_scan_result_ref: string | null
  security_scanned_at: string | null
  plaintext_retention_state: ContentBlobPlaintextRetentionState
  plaintext_purged_at: string | null
  storage_ref: string
  storage_provider: string | null
  storage_bucket: string | null
  storage_object_key: string | null
  storage_endpoint: string | null
  gateway_url: string | null
  ipfs_cid: string | null
  rejection_code: string | null
  claim_kind: "asset_payload" | "song_artifact" | "deck_import" | null
  claim_ref: string | null
  claimed_at: string | null
  created_at: string
  updated_at: string
}

export type ContentUploadSessionRow = {
  content_upload_session_id: string
  content_blob_id: string
  uploader_user_id: string
  status: ContentUploadSessionStatus
  upload_mode: ContentUploadMode
  object_key: string
  provider_upload_id: string | null
  part_size_bytes: number | null
  total_parts: number | null
  bucket: string
  storage_endpoint: string
  expires_at: string
  created_at: string
  updated_at: string
  completed_at: string | null
  aborted_at: string | null
  aborted_reason: string | null
}

export type OwnedContentBlob = {
  blob: ContentBlobRow
  uploadSession: ContentUploadSessionRow | null
}

export type CreateContentBlobIntentInput = {
  contentBlobId: string
  contentUploadSessionId: string
  communityId: string
  uploaderUserId: string
  validationProfile: string
  declaredFilename: string | null
  declaredMimeType: string
  declaredSizeBytes: number | null
  declaredContentHash: string | null
  storageRef: string
  uploadMode: ContentUploadMode
  objectKey: string
  providerUploadId: string | null
  partSizeBytes: number | null
  totalParts: number | null
  bucket: string
  storageEndpoint: string
  expiresAt: string
  createdAt: string
}
