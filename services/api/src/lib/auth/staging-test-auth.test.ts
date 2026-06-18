import { describe, expect, test } from "bun:test"
import { SignJWT } from "jose"
import {
  STAGING_TEST_JWT_AUDIENCE,
  STAGING_TEST_JWT_ISSUER,
  stagingTestAuthAvailable,
  verifyStagingTestJwt,
} from "./staging-test-auth"
import type { Env } from "../../env"

const SECRET = "test-staging-secret-do-not-use-in-prod"

async function mint(opts: {
  sub?: string
  issuer?: string
  audience?: string
  secret?: string
  wallets?: string[]
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {}
  if (opts.wallets) {
    payload.wallet_addresses = opts.wallets
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(opts.issuer ?? STAGING_TEST_JWT_ISSUER)
    .setAudience(opts.audience ?? STAGING_TEST_JWT_AUDIENCE)
    .setSubject(opts.sub ?? "usr_pilot_owner")
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .sign(new TextEncoder().encode(opts.secret ?? SECRET))
}

const stagingEnv: Env = {
  ENVIRONMENT: "staging",
  STAGING_TEST_AUTH_ENABLED: "true",
  STAGING_TEST_JWT_SHARED_SECRET: SECRET,
} as Env

describe("staging test issuer (fail-closed)", () => {
  test("accepts a valid token in staging with opt-in + secret", async () => {
    const jwt = await mint({ sub: "usr_pilot_owner", wallets: ["0x1111111111111111111111111111111111111111"] })
    const identity = await verifyStagingTestJwt({ env: stagingEnv, jwt })
    expect(identity.provider).toBe("jwt")
    expect(identity.providerSubject).toBe(`${STAGING_TEST_JWT_ISSUER}|usr_pilot_owner`)
    expect(identity.providerUserRef).toBe("usr_pilot_owner")
    expect(identity.selectedWalletAddress).toBe("0x1111111111111111111111111111111111111111")
    expect(stagingTestAuthAvailable(stagingEnv)).toBe(true)
  })

  test("REJECTS in production even when the secret + flag are present", async () => {
    const jwt = await mint()
    const prodEnv = { ...stagingEnv, ENVIRONMENT: "production" } as Env
    expect(stagingTestAuthAvailable(prodEnv)).toBe(false)
    await expect(verifyStagingTestJwt({ env: prodEnv, jwt })).rejects.toThrow()
  })

  test("REJECTS in dev / unknown environment even with secret + flag", async () => {
    const jwt = await mint()
    for (const environment of [undefined, "dev", "development", "preview"]) {
      const env = { ...stagingEnv, ENVIRONMENT: environment } as Env
      expect(stagingTestAuthAvailable(env)).toBe(false)
      await expect(verifyStagingTestJwt({ env, jwt })).rejects.toThrow()
    }
  })

  test("REJECTS when opt-in flag is off, even in staging", async () => {
    const jwt = await mint()
    const env = { ...stagingEnv, STAGING_TEST_AUTH_ENABLED: "false" } as Env
    expect(stagingTestAuthAvailable(env)).toBe(false)
    await expect(verifyStagingTestJwt({ env, jwt })).rejects.toThrow()
  })

  test("REJECTS when secret is missing", async () => {
    const jwt = await mint()
    const env = { ...stagingEnv, STAGING_TEST_JWT_SHARED_SECRET: "" } as Env
    expect(stagingTestAuthAvailable(env)).toBe(false)
    await expect(verifyStagingTestJwt({ env, jwt })).rejects.toThrow()
  })

  test("REJECTS a token from the real upstream issuer (no cross-trust)", async () => {
    const jwt = await mint({ issuer: "pirate-staging-upstream" })
    await expect(verifyStagingTestJwt({ env: stagingEnv, jwt })).rejects.toThrow()
  })

  test("REJECTS wrong audience and wrong signing secret", async () => {
    const wrongAud = await mint({ audience: "pirate-api-staging" })
    await expect(verifyStagingTestJwt({ env: stagingEnv, jwt: wrongAud })).rejects.toThrow()
    const wrongSecret = await mint({ secret: "some-other-secret" })
    await expect(verifyStagingTestJwt({ env: stagingEnv, jwt: wrongSecret })).rejects.toThrow()
  })
})
