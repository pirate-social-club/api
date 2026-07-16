import { describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import {
  resolveStoryAccessControllerDirectSigner,
  resolveStoryCdrWriterDirectSigner,
  resolveStoryCoordinatorDirectSigner,
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
      resolveStoryCoordinatorDirectSigner(legacyOnly),
    ]
    for (const result of results) {
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBeNull()
    }
  })

  test("keeps the coordinator signer isolated from the legacy settlement key", () => {
    const legacyOnly = {
      MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    } as Env
    const coordinatorOnly = {
      STORY_COORDINATOR_SIGNER_PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    } as Env

    const missingCoordinator = resolveStoryCoordinatorDirectSigner(legacyOnly)
    expect(missingCoordinator.ok).toBe(true)
    if (missingCoordinator.ok) expect(missingCoordinator.value).toBeNull()

    const coordinator = resolveStoryCoordinatorDirectSigner(coordinatorOnly)
    expect(coordinator.ok).toBe(true)
    if (coordinator.ok) expect(coordinator.value?.address).toBe("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC")

    const missingLegacy = resolveStorySettlementDirectSigner(coordinatorOnly)
    expect(missingLegacy.ok).toBe(true)
    if (missingLegacy.ok) expect(missingLegacy.value).toBeNull()
  })
})
