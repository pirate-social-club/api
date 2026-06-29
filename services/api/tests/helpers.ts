import { SignJWT } from "jose"
import { createClient, type Client } from "@libsql/client"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Env } from "../src/types"
import { setClawkeyProviderForTests } from "../src/lib/agents/clawkey-provider"
import { setSelfProviderForTests, type SelfProvider } from "../src/lib/verification/self-provider"
import { setVeryProviderForTests } from "../src/lib/verification/very-provider"
import { setPassportProviderForTests } from "../src/lib/verification/passport-provider"
import { resetPassportWalletScoreRefreshLimitsForTests } from "../src/lib/verification/passport-wallet-score-service"
import { setEnsResolverForTests } from "../src/lib/auth/ens-linked-handle-service"
import { setStoryAccessProofSignerForTests } from "../src/lib/story/story-access-proof-service"
import { setStoryCdrUploaderForTests } from "../src/lib/story/story-cdr"
import { setStoryAssetPublisherForTests } from "../src/lib/story/story-publish-service"
import { setStoryRoyaltyRegistrarForTests } from "../src/lib/story/story-royalty-registration-service"
import {
  setStoryParentRoyaltyVaultTransferExecutorForTests,
  setStoryRoyaltyPurchaseSettlementExecutorForTests,
} from "../src/lib/story/story-royalty-settlement-service"
import { setStoryRuntimeFundingAssertionForTests } from "../src/lib/story/story-runtime-funding"
import { setSwarmPublisherForTests } from "../src/lib/swarm/swarm-publisher"
import { setCommunityCommerceCharityPayoutExecutorForTests } from "../src/lib/communities/commerce/charity-payout-service"
import { setCommunityCommerceBuyerFundingVerifierForTests } from "../src/lib/communities/commerce/funding-proof-service"
import {
  applyLocalControlPlaneMigrations,
  resolveLocalDevStorage,
} from "../scripts/_lib/local-dev-storage"

import { resetMaterializedPublicHomeFeedForTests } from "../src/lib/feed/materialized-public-feed"
import { resolveCoreRepoPath } from "../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import { resetPublicReadCacheDedupeForTests } from "../src/lib/public-read-cache-state"

const encoder = new TextEncoder()
const ROUTE_TEST_LOCK_PATH = join(tmpdir(), "pirate-api-route-test-lock")
const ROUTE_TEST_LOCK_METADATA_PATH = join(ROUTE_TEST_LOCK_PATH, "owner.json")
const ROUTE_TEST_LOCK_STALE_MS = 10 * 60 * 1000

type RouteTestLockMetadata = {
  ownerId: string
  pid: number
  acquiredAt: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireRouteTestLock(timeoutMs = 30000): Promise<() => Promise<void>> {
  const startedAt = Date.now()
  const ownerId = randomUUID()

  while (true) {
    try {
      await mkdir(ROUTE_TEST_LOCK_PATH)
      await writeFile(ROUTE_TEST_LOCK_METADATA_PATH, JSON.stringify({
        ownerId,
        pid: process.pid,
        acquiredAt: Date.now(),
      } satisfies RouteTestLockMetadata))
      return async () => {
        const metadata = await readRouteTestLockMetadata()
        if (metadata?.ownerId === ownerId) {
          await rm(ROUTE_TEST_LOCK_PATH, { recursive: true, force: true })
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error
      }
      if (await isRouteTestLockStale()) {
        await rm(ROUTE_TEST_LOCK_PATH, { recursive: true, force: true })
        continue
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const metadata = await readRouteTestLockMetadata()
        throw new Error(`Timed out waiting for route test lock after ${timeoutMs}ms (${formatRouteTestLockMetadata(metadata)})`)
      }
      await sleep(25)
    }
  }
}

async function readRouteTestLockMetadata(): Promise<RouteTestLockMetadata | null> {
  try {
    const rawMetadata = await readFile(ROUTE_TEST_LOCK_METADATA_PATH, "utf8")
    const metadata = JSON.parse(rawMetadata) as Partial<RouteTestLockMetadata>
    if (
      typeof metadata.ownerId === "string"
      && typeof metadata.pid === "number"
      && Number.isInteger(metadata.pid)
      && typeof metadata.acquiredAt === "number"
    ) {
      return metadata as RouteTestLockMetadata
    }
  } catch {
    return null
  }
  return null
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function isRouteTestLockStale(): Promise<boolean> {
  const metadata = await readRouteTestLockMetadata()
  if (!metadata) {
    try {
      const lockStats = await stat(ROUTE_TEST_LOCK_PATH)
      return Date.now() - lockStats.mtimeMs >= ROUTE_TEST_LOCK_STALE_MS
    } catch {
      return true
    }
  }
  if (Date.now() - metadata.acquiredAt >= ROUTE_TEST_LOCK_STALE_MS) return true
  return !isProcessAlive(metadata.pid)
}

function formatRouteTestLockMetadata(metadata: RouteTestLockMetadata | null): string {
  if (!metadata) return "lock metadata unavailable"
  return `owner pid ${metadata.pid}, acquired ${new Date(metadata.acquiredAt).toISOString()}`
}

export function resetMemoryStore(): void {
  delete (globalThis as typeof globalThis & { __pirateMemoryAuthStore?: unknown }).__pirateMemoryAuthStore
}

export function resetRuntimeCaches(): void {
  resetMemoryStore()
  resetMaterializedPublicHomeFeedForTests()
  resetPublicReadCacheDedupeForTests()
  setClawkeyProviderForTests(null)
  setSelfProviderForTests(null)
  setVeryProviderForTests(null)
  setPassportProviderForTests(null)
  resetPassportWalletScoreRefreshLimitsForTests()
  setEnsResolverForTests(null)
  setStoryAccessProofSignerForTests(null)
  setStoryCdrUploaderForTests(null)
  setStoryAssetPublisherForTests(null)
  setStoryRoyaltyRegistrarForTests(null)
  setStoryRoyaltyPurchaseSettlementExecutorForTests(null)
  setStoryParentRoyaltyVaultTransferExecutorForTests(null)
  setStoryRuntimeFundingAssertionForTests(null)
  setSwarmPublisherForTests(null)
  setCommunityCommerceCharityPayoutExecutorForTests(null)
  setCommunityCommerceBuyerFundingVerifierForTests(null)
  const scope = globalThis as typeof globalThis & {
    __pirateSingletons?: Map<string, unknown>
  }
  scope.__pirateSingletons?.clear()
}

export function buildVerifiedSelfProvider(upstreamSessionRef: string): SelfProvider {
  let sessionCounter = 0
  return {
    startSession: async () => {
      sessionCounter += 1
      const sessionRef = `${upstreamSessionRef}:${sessionCounter}`
      return {
        upstreamSessionRef: sessionRef,
        launch: {
          app_name: "Pirate",
          endpoint: "https://self.xyz",
          endpoint_type: "https",
          scope: "profile_verification",
          session_id: sessionRef,
          user_id: "test",
          user_id_type: "uuid",
          disclosures: { date_of_birth: true },
        },
      }
    },
    getSessionOutcome: async (input) => ({
      status: "verified",
      claims: { age_over_18: true, nationality: null, gender: null, nullifier: input.upstreamSessionRef },
    }),
  }
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
    wallet_address?: string
    wallet_addresses?: string[]
    selected_wallet_address?: string
  } = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const claims: Record<string, unknown> = {}
  if (input.wallet_address !== undefined) claims.wallet_address = input.wallet_address
  if (input.wallet_addresses !== undefined) claims.wallet_addresses = input.wallet_addresses
  if (input.selected_wallet_address !== undefined) claims.selected_wallet_address = input.selected_wallet_address

  return await new SignJWT(claims)
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

type FetchMock = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>

export function mockFetch(handler: FetchMock): typeof fetch {
  return Object.assign(handler, {
    preconnect: (() => {}) as typeof fetch.preconnect,
  }) as typeof fetch
}

export async function withMockedFetch<T>(
  buildHandler: (originalFetch: typeof fetch) => FetchMock,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch(buildHandler(originalFetch))
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function applySqlFile(client: Client, path: string | URL): Promise<void> {
  const rawSql = await readFile(path, "utf8")
  const statements = splitSqlStatements(rawSql)
  for (const statement of statements) {
    for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
      await client.execute(sqliteStatement)
    }
  }
}

export async function createControlPlaneTestClient(options?: {
  includeAllMigrations?: boolean
}): Promise<{
  client: Client
  databasePath: string
  cleanup: () => Promise<void>
}> {
  const serviceRoot = fileURLToPath(new URL("..", import.meta.url))
  const tempDir = await mkdtemp(join(tmpdir(), "pirate-api-auth-"))
  const databasePath = join(tempDir, "control-plane.db")
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    if (options?.includeAllMigrations) {
      const storage = resolveLocalDevStorage({
        CONTROL_PLANE_DATABASE_URL: `file:${databasePath}`,
        LOCAL_COMMUNITY_DB_ROOT: join(tempDir, "community-dbs"),
      // Route tests should be reproducible from this API worktree. By default,
      // use the pinned API fixture migrations instead of silently picking up an
      // adjacent local core checkout, which may be on an unrelated dirty branch.
      // An explicit PIRATE_CORE_REPO still wins for contract/cross-repo checks.
      PIRATE_CORE_REPO: process.env.PIRATE_CORE_REPO ?? join(serviceRoot, "test-fixtures"),
      }, serviceRoot)
      await applyLocalControlPlaneMigrations(storage)
    } else {
      await applySqlFile(client, resolveCoreRepoPath("db/control-plane/migrations/0000_control_plane_baseline_postgres.sql", {
        serviceRoot,
      }))
      await applySqlFile(client, resolveCoreRepoPath("db/control-plane/migrations/0059_control_plane_identity_nullifiers.sql", {
        serviceRoot,
      }))
    }
  } catch (error) {
    client.close()
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }

  return {
    client,
    databasePath,
    cleanup: async () => {
      try {
        client.close()
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
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
  const serviceRoot = fileURLToPath(new URL("..", import.meta.url))
  const previousCoreRepo = process.env.PIRATE_CORE_REPO
  if (!previousCoreRepo) {
    process.env.PIRATE_CORE_REPO = join(serviceRoot, "test-fixtures")
  }

  try {
    const controlPlane = await createControlPlaneTestClient({ includeAllMigrations: true })
    const communityDbRoot = await mkdtemp(join(tmpdir(), "pirate-api-community-"))
    const env = buildTestEnv({
      DEV_MEMORY_STORE_ENABLED: "false",
      ENVIRONMENT: "test",
      CONTROL_PLANE_DATABASE_URL: `file:${controlPlane.databasePath}`,
      LOCAL_COMMUNITY_DB_ROOT: communityDbRoot,
      MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: "0x5000000000000000000000000000000000000000000000000000000000000005",
      PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY: "0x6000000000000000000000000000000000000000000000000000000000000006",
      PIRATE_CHECKOUT_RPC_URL: "http://127.0.0.1:8545",
      PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: "0x6000000000000000000000000000000000000000000000000000000000000006",
      PIRATE_BOOKING_SETTLEMENT_RPC_URL: "http://127.0.0.1:8545",
      ENDAOMENT_REGISTRY_ADDRESS: "0x7777777777777777777777777777777777777777",
      ...overrides,
    })

    return {
      env,
      client: controlPlane.client,
      controlPlaneDatabasePath: controlPlane.databasePath,
      communityDbRoot,
      cleanup: async () => {
        try {
          resetRuntimeCaches()
          await controlPlane.cleanup()
          await rm(communityDbRoot, { recursive: true, force: true })
        } finally {
          if (previousCoreRepo === undefined) {
            delete process.env.PIRATE_CORE_REPO
          } else {
            process.env.PIRATE_CORE_REPO = previousCoreRepo
          }
          await releaseLock()
        }
      },
    }
  } catch (error) {
    if (previousCoreRepo === undefined) {
      delete process.env.PIRATE_CORE_REPO
    } else {
      process.env.PIRATE_CORE_REPO = previousCoreRepo
    }
    await releaseLock()
    throw error
  }
}
