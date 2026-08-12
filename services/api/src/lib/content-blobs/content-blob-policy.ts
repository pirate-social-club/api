import { CONTENT_SOURCE_MAX_BYTES } from "@pirate/content-source-protocol"
import { badRequestError } from "../errors"
import type { ContentUploadMode } from "./content-blob-types"

export const CONTENT_BLOB_PROXY_MAX_BYTES = CONTENT_SOURCE_MAX_BYTES

const SUPPORTED_VALIDATION_PROFILES = new Set([
  "download_file_v1",
  "deck_import_csv_v1",
])

const DOWNLOAD_FILE_EXTENSIONS_BY_MIME = new Map<string, ReadonlySet<string>>([
  ["text/csv", new Set(["csv"])],
  ["text/tab-separated-values", new Set(["tsv"])],
  ["text/plain", new Set(["txt"])],
  ["application/json", new Set(["json"])],
])

export type CreateContentBlobRequest = {
  validation_profile: string
  declared_filename?: string | null
  declared_mime_type: string
  declared_size_bytes?: number | null
  declared_content_hash?: string | null
  upload_mode: ContentUploadMode
}

export function normalizeContentHash(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() || null
  if (normalized && !/^0x[a-f0-9]{64}$/.test(normalized)) {
    throw badRequestError("declared_content_hash must be a SHA-256 hex digest with 0x prefix")
  }
  return normalized
}

export function normalizeFilename(value: string | null | undefined): string | null {
  const filename = value?.trim() || null
  if (filename && filename.length > 255) {
    throw badRequestError("declared_filename must be at most 255 characters")
  }
  return filename
}

export function normalizeMimeType(value: string): string {
  const mimeType = value?.trim().toLowerCase()
  if (!mimeType || mimeType.length > 255 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)) {
    throw badRequestError("declared_mime_type must be a valid MIME type")
  }
  return mimeType
}

function filenameExtension(filename: string): string | null {
  const finalSegment = filename.split(/[\\/]/).at(-1) ?? ""
  const separator = finalSegment.lastIndexOf(".")
  if (separator < 1 || separator === finalSegment.length - 1) return null
  return finalSegment.slice(separator + 1).toLowerCase()
}

function assertValidationProfileDeclaration(input: {
  validationProfile: string
  filename: string | null
  mimeType: string
}): void {
  const allowedExtensions = DOWNLOAD_FILE_EXTENSIONS_BY_MIME.get(input.mimeType)
  if (!allowedExtensions) {
    throw badRequestError(`${input.validationProfile} does not accept declared_mime_type ${input.mimeType}`)
  }
  if (input.validationProfile === "deck_import_csv_v1" && input.mimeType !== "text/csv") {
    throw badRequestError("deck_import_csv_v1 requires text/csv")
  }
  if (input.filename) {
    const extension = filenameExtension(input.filename)
    if (!extension || !allowedExtensions.has(extension)) {
      throw badRequestError("declared_filename extension does not match declared_mime_type")
    }
  }
}

export function assertCreateContentBlobRequest(body: CreateContentBlobRequest): void {
  const validationProfile = String(body.validation_profile ?? "").trim()
  if (!SUPPORTED_VALIDATION_PROFILES.has(validationProfile)) {
    throw badRequestError("Unsupported validation_profile")
  }
  const filename = normalizeFilename(body.declared_filename)
  const mimeType = normalizeMimeType(body.declared_mime_type)
  assertValidationProfileDeclaration({ validationProfile, filename, mimeType })
  normalizeContentHash(body.declared_content_hash)
  if (body.upload_mode !== "proxy" && body.upload_mode !== "direct_multipart") {
    throw badRequestError("Unsupported upload_mode")
  }
  if (body.upload_mode === "direct_multipart") {
    throw badRequestError("direct_multipart content blobs are not enabled yet")
  }
  if (body.declared_size_bytes != null) {
    if (!Number.isSafeInteger(body.declared_size_bytes) || body.declared_size_bytes <= 0) {
      throw badRequestError("declared_size_bytes must be a positive integer")
    }
    if (body.declared_size_bytes > CONTENT_BLOB_PROXY_MAX_BYTES) {
      throw badRequestError("Proxy content blobs are limited to 50 MiB")
    }
  }
}
