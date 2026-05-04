import { describe, expect, test } from "bun:test"
import { sanitizeLogText, summarizeReference, summarizeUrl } from "../src/lib/observability/pipeline-log"

describe("pipeline log sanitization", () => {
  test("summarizes URLs without keeping path or query values", () => {
    const summary = summarizeUrl("https://example.com/private/story?token=secret")
    expect(summary).toMatchObject({
      has_url: true,
      url_scheme: "https",
      url_host: "example.com",
    })
    expect(JSON.stringify(summary)).not.toContain("private")
    expect(JSON.stringify(summary)).not.toContain("secret")
  })

  test("sanitizes free-form provider text", () => {
    const sanitized = sanitizeLogText("failed for https://example.com/story?token=secret and user@example.com")
    expect(sanitized).toBe("failed for [url] and [email]")
  })

  test("hashes unsafe references while preserving short status references", () => {
    expect(summarizeReference("result_ref", "skipped:no_markdown")).toEqual({
      result_ref: "skipped:no_markdown",
    })

    const unsafe = summarizeReference("subject_id", "https://example.com/story?token=secret")
    expect(JSON.stringify(unsafe)).not.toContain("secret")
    expect(unsafe.subject_id_url_host).toBe("example.com")
  })
})
