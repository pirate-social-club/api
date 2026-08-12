export const CONTENT_SOURCE_MAX_BYTES = 50 * 1024 * 1024
export const CONTENT_SOURCE_STORAGE_NAMESPACE = "content-source/v1"

const CONTENT_BLOB_ID_PATTERN = /^cbl_[A-Za-z0-9_-]{1,128}$/u
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u
const CONTENT_SCAN_JOB_REF_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u

export function isContentBlobId(value: string): boolean {
  return CONTENT_BLOB_ID_PATTERN.test(value)
}

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value)
}

export function isContentScanJobRef(value: string): boolean {
  return CONTENT_SCAN_JOB_REF_PATTERN.test(value)
}

export function contentSourceObjectKey(contentBlobId: string): string {
  if (!isContentBlobId(contentBlobId)) {
    throw new TypeError("Invalid content blob id")
  }
  return `${CONTENT_SOURCE_STORAGE_NAMESPACE}/${contentBlobId}`
}
