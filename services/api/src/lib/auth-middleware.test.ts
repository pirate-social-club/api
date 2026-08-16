import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { exportSPKI, generateKeyPair, SignJWT } from "jose"
import type { Env } from "../env"
import {
  authenticateAdminUserOrAgentDelegated,
  authenticateUserToken,
  requireBearerToken,
} from "./auth-middleware"
import { exchangeMemoryIdentity, getMemoryStore } from "./auth/dev/memory-auth-store"
import { AuthenticationFailureError, HttpError } from "./errors"
import { setControlPlanePostgresPoolFactoryForTests, withRequestControlPlaneClients } from "./runtime-deps"

type SessionPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]

let privateKey: SessionPrivateKey
let publicKeyPem: string

beforeAll(async () => {
  const keys = await generateKeyPair("RS256")
  privateKey = keys.privateKey
  publicKeyPem = await exportSPKI(keys.publicKey)
})

async function signSessionToken(userId: string, scope = "pirate_app_session"): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return new SignJWT({ scope, iat: nowSeconds - 10, exp: nowSeconds + 3_600 })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer("pirate-api")
    .setAudience("pirate-app")
    .setSubject(userId)
    .sign(privateKey)
}

function userRow(userId: string): Record<string, unknown> {
  const timestamp = new Date().toISOString()
  return {
    user_id: userId,
    primary_wallet_attachment_id: null,
    verification_state: "unverified",
    capability_provider: null,
    verification_capabilities_json: "{}",
    verified_at: null,
    current_verification_session_id: null,
    onboarding_dismissed_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  }
}

function controlPlanePool(input: {
  users: string[]
  aliases: Record<string, string>
}) {
  const query = async (sql: string, values: unknown[] = []) => {
    const normalized = sql.toLowerCase()
    const currentUserId = String(values[0] ?? "")
    if (normalized.includes("from users")) {
      return {
        rows: input.users.includes(currentUserId) ? [userRow(currentUserId)] : [],
        rowCount: input.users.includes(currentUserId) ? 1 : 0,
      }
    }
    if (normalized.includes("user_account_aliases") || normalized.includes("user_account_merges")) {
      const canonicalUserId = input.aliases[currentUserId]
      return {
        rows: canonicalUserId ? [{ canonical_user_id: canonicalUserId }] : [],
        rowCount: canonicalUserId ? 1 : 0,
      }
    }
    return { rows: [], rowCount: 0 }
  }
  const connection = {
    query,
    statementTimeoutMs: 15_000,
    abortPendingQuery: () => {},
    release: () => {},
  }
  return {
    query,
    statementTimeoutMs: 15_000,
    abortPendingQuery: () => {},
    connect: async () => connection,
    end: async () => {},
  }
}

afterEach(() => setControlPlanePostgresPoolFactoryForTests(null))

describe("authentication error classification", () => {
  test("classifies invalid bearer input as an authentication failure", () => {
    expect(() => requireBearerToken(undefined)).toThrow(AuthenticationFailureError)
  })

  test("does not retry operational user-auth failures as delegated credentials", async () => {
    await expect(authenticateAdminUserOrAgentDelegated({
      allowAgentDelegated: true,
      authorization: "Bearer invalid-token",
      env: {} as Env,
      xAdminAsUserId: undefined,
      xAdminToken: undefined,
    })).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
    } satisfies Partial<HttpError>)
  })

  test("rejects a user session when a device classification is required", async () => {
    const identity = await exchangeMemoryIdentity({
      provider: "jwt",
      providerSubject: `classification-${crypto.randomUUID()}`,
      providerUserRef: null,
      walletAddresses: [],
      selectedWalletAddress: null,
    })
    const userId = [...getMemoryStore().byUserId.keys()].at(-1)
    expect(userId).toBeTruthy()
    const env = {
      ENVIRONMENT: "development",
      DEV_MEMORY_STORE_ENABLED: "true",
      PIRATE_APP_JWT_PUBLIC_KEY: publicKeyPem,
    } as Env

    await expect(authenticateUserToken({
      env,
      token: await signSessionToken(userId as string),
      requiredClassification: "device",
    })).rejects.toBeInstanceOf(AuthenticationFailureError)
    expect(identity.user.id).toStartWith("usr_")
  })

  test("fails closed when an alias points at a missing canonical user", async () => {
    const sourceUserId = "usr_alias_source_missing_target"
    const env = {
      ENVIRONMENT: "staging",
      CONTROL_PLANE_DATABASE_URL: "postgres://alias-target-test",
      PIRATE_APP_JWT_PUBLIC_KEY: publicKeyPem,
    } as Env
    setControlPlanePostgresPoolFactoryForTests(() => controlPlanePool({
      users: [sourceUserId],
      aliases: { [sourceUserId]: "usr_missing_canonical" },
    }))

    await expect(withRequestControlPlaneClients(async () => authenticateUserToken({
      env,
      token: await signSessionToken(sourceUserId),
    }))).rejects.toBeInstanceOf(AuthenticationFailureError)
  })

  test("fails closed when canonical alias resolution detects a cycle", async () => {
    const sourceUserId = "usr_alias_cycle_source"
    const targetUserId = "usr_alias_cycle_target"
    const env = {
      ENVIRONMENT: "staging",
      CONTROL_PLANE_DATABASE_URL: "postgres://alias-cycle-test",
      PIRATE_APP_JWT_PUBLIC_KEY: publicKeyPem,
    } as Env
    setControlPlanePostgresPoolFactoryForTests(() => controlPlanePool({
      users: [sourceUserId, targetUserId],
      aliases: { [sourceUserId]: targetUserId, [targetUserId]: sourceUserId },
    }))

    await expect(withRequestControlPlaneClients(async () => authenticateUserToken({
      env,
      token: await signSessionToken(sourceUserId),
    }))).rejects.toBeInstanceOf(AuthenticationFailureError)
  })
})
