import { describe, expect, test } from "bun:test"
import {
  CONTENT_SOURCE_MAX_BYTES,
  CONTENT_SOURCE_STORAGE_NAMESPACE,
  contentSourceObjectKey,
  isContentBlobId,
  isContentScanJobRef,
  isSha256Hex,
} from "./index"

describe("content source protocol", () => {
  test("owns the source namespace and size ceiling", () => {
    expect(CONTENT_SOURCE_STORAGE_NAMESPACE).toBe("content-source/v1")
    expect(CONTENT_SOURCE_MAX_BYTES).toBe(50 * 1024 * 1024)
    expect(contentSourceObjectKey("cbl_fixture")).toBe("content-source/v1/cbl_fixture")
  })

  test("validates identifiers shared across service boundaries", () => {
    expect(isContentBlobId("cbl_fixture-1")).toBe(true)
    expect(isContentBlobId("fixture")).toBe(false)
    expect(isContentScanJobRef("scan_job-1")).toBe(true)
    expect(isContentScanJobRef("scan/job")).toBe(false)
  })

  test("accepts only lowercase unprefixed SHA-256 hex", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true)
    expect(isSha256Hex("A".repeat(64))).toBe(false)
    expect(isSha256Hex(`0x${"a".repeat(64)}`)).toBe(false)
  })

  test("rejects unsafe object-key input", () => {
    expect(() => contentSourceObjectKey("../fixture")).toThrow("Invalid content blob id")
  })
})
