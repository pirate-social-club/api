import { describe, expect, test } from "bun:test"

const LEGACY_VERIFICATION_WRITERS: string[] = [
  "namespace-revalidation-cron.ts",
  "namespace-verification-policy.ts",
  "namespace-verification-restart.ts",
  "namespace-verification-service.ts",
  "namespace-verification-start.ts",
]

describe("root-delegation authority boundary", () => {
  test.each(LEGACY_VERIFICATION_WRITERS)(
    "%s cannot read or write root-delegation tables",
    async (fileName) => {
      const source = await Bun.file(new URL(fileName, import.meta.url)).text()

      // These modules own session-scoped ownership, attachment, and expiry
      // evidence. Root-delegation freshness has a separate authority. Matching
      // the namespace prefix makes this a ratchet for future root tables too.
      expect(source).not.toMatch(/\bhns_root_[a-z0-9_]+\b/u)
    },
  )
})
