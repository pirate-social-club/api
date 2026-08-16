import { beforeAll, describe, expect, test } from "bun:test"
import { generateKeyPair, SignJWT, type JWTPayload } from "jose"
import type { Env } from "../../env"
import { AuthenticationFailureError } from "../errors"
import { DEFAULT_PIRATE_APP_SCOPE, verifyPirateAccessToken } from "./pirate-session-token"

const IAT = 1_700_000_000
const EXP = 1_800_000_000

type SessionPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]

let privateKey: SessionPrivateKey
let env: Env

beforeAll(async () => {
  const keys = await generateKeyPair("RS256")
  privateKey = keys.privateKey
  const { exportSPKI } = await import("jose")
  env = {
    PIRATE_APP_JWT_PUBLIC_KEY: await exportSPKI(keys.publicKey),
  } as Env
})

async function signToken(input: {
  header?: Readonly<Record<string, unknown>>
  claims?: Readonly<Record<string, unknown>>
  omit?: readonly string[]
} = {}): Promise<string> {
  const payload = {
    iss: "pirate-api",
    aud: "pirate-app",
    sub: "usr_session_vector",
    scope: DEFAULT_PIRATE_APP_SCOPE,
    iat: IAT,
    exp: EXP,
    ...input.claims,
  } as JWTPayload
  for (const key of input.omit ?? []) delete payload[key]
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", ...input.header })
    .sign(privateKey)
}

describe("Pirate session token contract", () => {
  test("accepts the valid default session vector", async () => {
    await expect(verifyPirateAccessToken({ env, token: await signToken() })).resolves.toEqual({
      userId: "usr_session_vector",
      scope: DEFAULT_PIRATE_APP_SCOPE,
    })
  })

  test.each([
    ["reject-wrong-typ-contract", { header: { typ: "not-jwt" } }],
    ["contract-reject-missing-iat", { omit: ["iat"] }],
    ["contract-reject-missing-exp", { omit: ["exp"] }],
    ["contract-reject-malformed-iat", { claims: { iat: "not-a-number" } }],
    ["contract-reject-nonstring-scope", { claims: { scope: 42 } }],
  ] as const)("rejects %s", async (_name, recipe) => {
    await expect(verifyPirateAccessToken({ env, token: await signToken(recipe) }))
      .rejects.toBeInstanceOf(AuthenticationFailureError)
  })

  test("keeps the documented empty-scope fallback", async () => {
    await expect(verifyPirateAccessToken({
      env,
      token: await signToken({ claims: { scope: "" } }),
    })).resolves.toEqual({
      userId: "usr_session_vector",
      scope: DEFAULT_PIRATE_APP_SCOPE,
    })
  })
})
