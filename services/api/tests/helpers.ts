import { SignJWT } from "jose"
import { createClient, type Client } from "@libsql/client"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Env } from "../src/types"
import { setSelfProviderForTests } from "../src/lib/verification/self-provider"
import { setVeryProviderForTests } from "../src/lib/verification/very-provider"

import { splitSqlStatements, toSqliteCompatibleStatement } from "../shared/sql-migration"

const encoder = new TextEncoder()

export function resetMemoryStore(): void {
  delete (globalThis as typeof globalThis & { __pirateMemoryAuthStore?: unknown }).__pirateMemoryAuthStore
}

export function resetRuntimeCaches(): void {
  resetMemoryStore()
  setSelfProviderForTests(null)
  setVeryProviderForTests(null)
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
    const migrationsDir = new URL("../../../../db/control-plane/migrations/", import.meta.url)
    const entries = (await readdir(migrationsDir))
      .filter((entry) => entry.endsWith(".sql"))
      .sort()
    const baselineEntry = entries.find((entry) => entry.startsWith("0000_") && entry.includes("baseline"))
    const entriesToApply = baselineEntry ? [baselineEntry] : entries
    for (const entry of entriesToApply) {
      await applySqlFile(client, new URL(entry, migrationsDir))
    }
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
  const controlPlane = await createControlPlaneTestClient({ includeAllMigrations: true })
  const communityDbRoot = await mkdtemp(join(tmpdir(), "pirate-v2-community-"))
  const env = buildTestEnv({
    DEV_MEMORY_STORE_ENABLED: "false",
    ENVIRONMENT: "test",
    TURSO_CONTROL_PLANE_DATABASE_URL: `file:${controlPlane.databasePath}`,
    LOCAL_COMMUNITY_DB_ROOT: communityDbRoot,
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
    },
  }
}
