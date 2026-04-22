import { SignJWT } from "jose"
import { createClient, type Client } from "@libsql/client"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Env } from "../src/types"
import { setClawkeyProviderForTests } from "../src/lib/agents/clawkey-provider"
import { setSelfProviderForTests } from "../src/lib/verification/self-provider"
import { setVeryProviderForTests } from "../src/lib/verification/very-provider"
import { setEnsResolverForTests } from "../src/lib/auth/ens-linked-handle-service"
import { setStoryAccessProofSignerForTests } from "../src/lib/story/story-access-proof-service"
import { setStoryCdrUploaderForTests } from "../src/lib/story/story-cdr"
import { setStoryAssetPublisherForTests } from "../src/lib/story/story-publish-service"
import { setStoryRoyaltyRegistrarForTests } from "../src/lib/story/story-royalty-registration-service"
import { setStoryRoyaltyPurchaseSettlementExecutorForTests } from "../src/lib/story/story-royalty-settlement-service"
import { setStoryRuntimeFundingAssertionForTests } from "../src/lib/story/story-runtime-funding"
import { setStoryPurchaseSettlementExecutorForTests } from "../src/lib/story/story-settlement-service"
import { setSwarmPublisherForTests } from "../src/lib/swarm/swarm-publisher"
import { setCommunityCommerceCharityPayoutExecutorForTests } from "../src/lib/communities/commerce/charity-payout-service"
import { setCommunityCommerceBuyerFundingVerifierForTests } from "../src/lib/communities/commerce/funding-proof-service"
import {
  applyLocalControlPlaneMigrations,
  resolveLocalDevStorage,
} from "../scripts/_lib/local-dev-storage"

import { splitSqlStatements, toSqliteCompatibleStatement } from "../shared/sql-migration"

const encoder = new TextEncoder()
const ROUTE_TEST_LOCK_PATH = join(tmpdir(), "pirate-v2-route-test-lock")

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireRouteTestLock(timeoutMs = 30000): Promise<() => Promise<void>> {
  const startedAt = Date.now()

  while (true) {
    try {
      await mkdir(ROUTE_TEST_LOCK_PATH)
      return async () => {
        await rm(ROUTE_TEST_LOCK_PATH, { recursive: true, force: true })
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for route test lock after ${timeoutMs}ms`)
      }
      await sleep(25)
    }
  }
}

export function resetMemoryStore(): void {
  delete (globalThis as typeof globalThis & { __pirateMemoryAuthStore?: unknown }).__pirateMemoryAuthStore
}

export function resetRuntimeCaches(): void {
  resetMemoryStore()
  setClawkeyProviderForTests(null)
  setSelfProviderForTests(null)
  setVeryProviderForTests(null)
  setEnsResolverForTests(null)
  setStoryAccessProofSignerForTests(null)
  setStoryCdrUploaderForTests(null)
  setStoryAssetPublisherForTests(null)
  setStoryRoyaltyRegistrarForTests(null)
  setStoryRoyaltyPurchaseSettlementExecutorForTests(null)
  setStoryRuntimeFundingAssertionForTests(null)
  setStoryPurchaseSettlementExecutorForTests(null)
  setSwarmPublisherForTests(null)
  setCommunityCommerceCharityPayoutExecutorForTests(null)
  setCommunityCommerceBuyerFundingVerifierForTests(null)
  const scope = globalThis as typeof globalThis & {
    __pirateSingletons?: Map<string, unknown>
  }
  scope.__pirateSingletons?.clear()
}

export function buildTestEnv(overrides: Partial<Env> = {}): Env {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })

  return {
    DEV_MEMORY_STORE_ENABLED: "true",
    JWT_BASED_AUTH_ENABLED: "true",
    AUTH_UPSTREAM_JWT_SHARED_SECRET: "test-upstream-shared-secret",
    AUTH_UPSTREAM_JWT_ISSUER: "pirate-test-upstream",
    AUTH_UPSTREAM_JWT_AUDIENCE: "pirate-api",
    PIRATE_APP_JWT_PRIVATE_KEY: privateKey,
    PIRATE_APP_JWT_PUBLIC_KEY: publicKey,
    PIRATE_APP_JWT_ISSUER: "pirate-api",
    PIRATE_APP_JWT_AUDIENCE: "pirate-app",
    PIRATE_APP_JWT_TTL_SECONDS: "3600",
    ...overrides,
  }
}

export async function mintUpstreamJwt(
  env: Env,
  input: {
    sub?: string
    iss?: string
    aud?: string
    exp?: number
  } = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return await new SignJWT()
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(input.iss ?? String(env.AUTH_UPSTREAM_JWT_ISSUER))
    .setAudience(input.aud ?? String(env.AUTH_UPSTREAM_JWT_AUDIENCE))
    .setSubject(input.sub ?? "test-user")
    .setIssuedAt(nowSeconds)
    .setExpirationTime(input.exp ?? nowSeconds + 3600)
    .sign(encoder.encode(String(env.AUTH_UPSTREAM_JWT_SHARED_SECRET)))
}

export async function json(response: Response): Promise<unknown> {
  return await response.json()
}

async function applySqlFile(client: Client, path: URL): Promise<void> {
  const rawSql = await readFile(path, "utf8")
  const statements = splitSqlStatements(rawSql)
  for (const statement of statements) {
    const sqliteStatement = toSqliteCompatibleStatement(statement)
    if (!sqliteStatement) {
      continue
    }
    await client.execute(sqliteStatement)
  }
}

export async function createControlPlaneTestClient(options?: {
  includeAllMigrations?: boolean
}): Promise<{
  client: Client
  databasePath: string
  cleanup: () => Promise<void>
}> {
  const databasePath = join(tmpdir(), `pirate-v2-auth-${randomUUID()}.db`)
  const client = createClient({
    url: `file:${databasePath}`,
  })

  if (options?.includeAllMigrations) {
    const serviceRoot = fileURLToPath(new URL("..", import.meta.url))
    const storage = resolveLocalDevStorage({
      CONTROL_PLANE_DATABASE_URL: `file:${databasePath}`,
      LOCAL_COMMUNITY_DB_ROOT: join(tmpdir(), `pirate-v2-community-${randomUUID()}`),
    }, serviceRoot)
    await applyLocalControlPlaneMigrations(storage)
  } else {
    await applySqlFile(client, new URL("../../../../db/control-plane/migrations/0001_control_plane_identity.sql", import.meta.url))
  }

  return {
    client,
    databasePath,
    cleanup: async () => {
      client.close()
      await rm(databasePath, { force: true })
    },
  }
}

export async function createRouteTestContext(overrides: Partial<Env> = {}): Promise<{
  env: Env
  client: Client
  controlPlaneDatabasePath: string
  communityDbRoot: string
  cleanup: () => Promise<void>
}> {
  const releaseLock = await acquireRouteTestLock()

  try {
    const controlPlane = await createControlPlaneTestClient({ includeAllMigrations: true })
    const communityDbRoot = await mkdtemp(join(tmpdir(), "pirate-v2-community-"))
    const env = buildTestEnv({
      DEV_MEMORY_STORE_ENABLED: "false",
      ENVIRONMENT: "test",
      CONTROL_PLANE_DATABASE_URL: `file:${controlPlane.databasePath}`,
      LOCAL_COMMUNITY_DB_ROOT: communityDbRoot,
      MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: "0x5000000000000000000000000000000000000000000000000000000000000005",
      PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY: "0x6000000000000000000000000000000000000000000000000000000000000006",
      PIRATE_CHECKOUT_RPC_URL: "http://127.0.0.1:8545",
      ENDAOMENT_REGISTRY_ADDRESS: "0x7777777777777777777777777777777777777777",
      ...overrides,
    })

    return {
      env,
      client: controlPlane.client,
      controlPlaneDatabasePath: controlPlane.databasePath,
      communityDbRoot,
      cleanup: async () => {
        resetRuntimeCaches()
        await controlPlane.cleanup()
        await rm(communityDbRoot, { recursive: true, force: true })
        await releaseLock()
      },
    }
  } catch (error) {
    await releaseLock()
    throw error
  }
}
