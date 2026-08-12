import { unixSeconds } from "../../serializers/time"
import type {
  ContentBlobRow,
  ContentUploadMode,
  ContentUploadSessionRow,
  OwnedContentBlob,
} from "./content-blob-types"

export type ContentUploadSession = {
  id: string
  status: ContentUploadSessionRow["status"]
  upload_mode: ContentUploadMode
  object_key: string
  provider_upload_id: string | null
  part_size_bytes: number | null
  total_parts: number | null
  expires_at: number
  sign_part_url: string | null
  complete_url: string | null
  abort_url: string | null
}

export type ContentBlob = {
  id: string
  object: "content_blob"
  community: string
  uploader_user: string
  status: ContentBlobRow["status"]
  validation_profile: string
  declared_filename: string | null
  declared_mime_type: string
  declared_size_bytes: number | null
  declared_content_hash: string | null
  detected_mime_type: string | null
  verified_size_bytes: number | null
  verified_content_hash: string | null
  security_scan_state: ContentBlobRow["security_scan_state"]
  rejection_code: string | null
  plaintext_retention_state: ContentBlobRow["plaintext_retention_state"]
  upload_url: string | null
  upload_session: ContentUploadSession | null
  created: number
}

export function serializeContentBlob(owned: OwnedContentBlob): ContentBlob {
  const { blob, uploadSession } = owned
  const uploadUrl = uploadSession?.upload_mode === "proxy"
    && blob.status === "pending_upload"
    && ["created", "parts_uploading"].includes(uploadSession.status)
    ? blob.storage_ref
    : null
  return {
    id: blob.content_blob_id,
    object: "content_blob",
    community: `com_${blob.community_id}`,
    uploader_user: `usr_${blob.uploader_user_id}`,
    status: blob.status,
    validation_profile: blob.validation_profile,
    declared_filename: blob.declared_filename,
    declared_mime_type: blob.declared_mime_type,
    declared_size_bytes: blob.declared_size_bytes,
    declared_content_hash: blob.declared_content_hash,
    detected_mime_type: blob.detected_mime_type,
    verified_size_bytes: blob.verified_size_bytes,
    verified_content_hash: blob.verified_content_hash,
    security_scan_state: blob.security_scan_state,
    rejection_code: blob.rejection_code,
    plaintext_retention_state: blob.plaintext_retention_state,
    upload_url: uploadUrl,
    upload_session: uploadSession ? {
      id: uploadSession.content_upload_session_id,
      status: uploadSession.status,
      upload_mode: uploadSession.upload_mode,
      object_key: uploadSession.object_key,
      provider_upload_id: uploadSession.provider_upload_id,
      part_size_bytes: uploadSession.part_size_bytes,
      total_parts: uploadSession.total_parts,
      expires_at: unixSeconds(uploadSession.expires_at),
      sign_part_url: null,
      complete_url: null,
      abort_url: null,
    } : null,
    created: unixSeconds(blob.created_at),
  }
}
