import { describe, expect, test } from "bun:test"
import { getZkPassportProvider } from "../src/lib/verification/zkpassport-provider"
import type { Env } from "../src/env"

async function startSessionDevMode(envOverrides: Record<string, string>): Promise<boolean | null | undefined> {
  const env = { PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.sc", ...envOverrides } as unknown as Env
  const session = await getZkPassportProvider(env).startSession({
    verificationSessionId: "ver_devmode_test",
    userId: "user_devmode_test",
    requestedCapabilities: ["nationality"],
    verificationRequirements: [{ proof_type: "nationality", required_values: ["US"] }],
    verificationIntent: null,
    policyId: null,
    challengeExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })
  return session.launch.dev_mode
}

describe("zkpassport dev mode", () => {
  test("supports a unique-human-only nullifier query", async () => {
    const env = { ENVIRONMENT: "test", PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.sc" } as unknown as Env
    const session = await getZkPassportProvider(env).startSession({
      verificationSessionId: "ver_unique_human_test",
      userId: "user_unique_human_test",
      requestedCapabilities: ["unique_human"],
      verificationRequirements: [],
      verificationIntent: "community_join",
      policyId: null,
      challengeExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    expect(session.launch.requested_capabilities).toEqual(["unique_human"])
  })

  test("ZKPASSPORT_DEV_MODE is ignored in production", async () => {
    expect(await startSessionDevMode({ ENVIRONMENT: "production", ZKPASSPORT_DEV_MODE: "1" })).toBe(false)
  })

  test("ZKPASSPORT_DEV_MODE enables dev mode outside production", async () => {
    expect(await startSessionDevMode({ ENVIRONMENT: "staging", ZKPASSPORT_DEV_MODE: "1" })).toBe(true)
  })

  test("dev mode defaults off outside production without the flag", async () => {
    expect(await startSessionDevMode({ ENVIRONMENT: "staging" })).toBe(false)
  })

  test("the test environment defaults dev mode on", async () => {
    expect(await startSessionDevMode({ ENVIRONMENT: "test" })).toBe(true)
  })
})
