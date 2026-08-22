import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const wranglerConfig = readFileSync(
  fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
  "utf8",
)
const zkPassportProvider = readFileSync(
  fileURLToPath(new URL("../src/lib/verification/zkpassport-provider.ts", import.meta.url)),
  "utf8",
)

describe("API Worker bundle boundary", () => {
  test("minifies production bundles and resolves Story through its tree-shakeable ESM build", () => {
    expect(wranglerConfig).toContain('"minify": true')
    expect(wranglerConfig).toContain(
      '"@story-protocol/core-sdk": "./node_modules/@story-protocol/core-sdk/dist/story-protocol-core-sdk.esm.js"',
    )
  })

  test("keeps the Barretenberg verifier in its dedicated container", () => {
    expect(zkPassportProvider).toContain(
      'import type { ProofResult, Query, QueryResult } from "@zkpassport/sdk"',
    )
    expect(zkPassportProvider).not.toContain("new ZKPassport(")
    expect(zkPassportProvider).not.toContain("verifyWithLocalZkPassportSdk")
  })
})
