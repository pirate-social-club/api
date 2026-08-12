import { describe, expect, test } from "bun:test"
import {
  CONTENT_SECURITY_SCAN_MESSAGE_VERSION,
  parseContentSecurityScanMessage,
} from "./content-security-types"

describe("content security scan message", () => {
  test("accepts only the versioned opaque job reference", () => {
    expect(parseContentSecurityScanMessage({
      schema_version: CONTENT_SECURITY_SCAN_MESSAGE_VERSION,
      scan_job_id: "csj_fixture-1",
    })).toEqual({ schema_version: 1, scan_job_id: "csj_fixture-1" })
    expect(parseContentSecurityScanMessage({ schema_version: 2, scan_job_id: "csj_fixture" })).toBeNull()
    expect(parseContentSecurityScanMessage({ schema_version: 1, scan_job_id: "../fixture" })).toBeNull()
    expect(parseContentSecurityScanMessage({
      schema_version: 1,
      scan_job_id: "csj_fixture",
      content: "forbidden bytes",
    })).toEqual({ schema_version: 1, scan_job_id: "csj_fixture" })
  })
})
