import { describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import {
  resolveStoryAccessControllerDirectSigner,
  resolveStoryCdrWriterDirectSigner,
  resolveStoryEntitlementClassConfigurerDirectSigner,
  resolveStoryOperatorDirectSigner,
  resolveStorySettlementDirectSigner,
} from "./story-direct-signer"

describe("Story direct signer role isolation", () => {
  test("does not resolve any role from the removed catch-all runtime key", () => {
    const legacyOnly = {
      STORY_RUNTIME_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    } as Env & { STORY_RUNTIME_PRIVATE_KEY: string }

    const results = [
      resolveStoryOperatorDirectSigner(legacyOnly),
      resolveStoryEntitlementClassConfigurerDirectSigner(legacyOnly),
      resolveStoryCdrWriterDirectSigner(legacyOnly),
      resolveStoryAccessControllerDirectSigner(legacyOnly),
      resolveStorySettlementDirectSigner(legacyOnly),
    ]
    for (const result of results) {
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBeNull()
    }
  })
})
