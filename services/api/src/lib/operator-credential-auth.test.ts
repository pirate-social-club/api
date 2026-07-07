import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  authenticateOperatorCredential,
  BOOKING_SETTLEMENT_RESOLVE_SCOPE,
  hashOperatorCredentialSecret,
  requireOperatorScope,
  type OperatorActorContext,
} from "./operator-credential-auth"
import { authenticateAdminToken } from "./auth-middleware"
import { createControlPlaneTestClient, resetRuntimeCaches } from "../../tests/helpers"
import type { Client } from "./sql-client"
import type { Env } from "../env"
import type { DbExecutor } from "./db-helpers"

const SECRET = "test-operator-secret-with-high-entropy-shape"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  resetRuntimeCaches()
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

async function setup(): Promise<{ client: Client; env: Env }> {
  const db = await createControlPlaneTestClient()
  cleanups.push(db.cleanup)
  await db.client.execute(`
    CREATE TABLE operator_credentials (
      operator_credential_id TEXT PRIMARY KEY,
      operator_actor_id TEXT NOT NULL,
      label TEXT NOT NULL,
      secret_hash TEXT NOT NULL UNIQUE,
      secret_hash_algo TEXT NOT NULL CHECK (secret_hash_algo IN ('sha256')),
      secret_hash_version INTEGER NOT NULL CHECK (secret_hash_version >= 1),
      scopes_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      rotated_at TEXT,
      revoked_at TEXT,
      superseded_by_credential_id TEXT,
      CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
      CHECK (expires_at > created_at)
    )
  `)
  return {
    client: db.client,
    env: { CONTROL_PLANE_DATABASE_URL: `file:${db.databasePath}` } as Env,
  }
}

async function seedCredential(client: Client, overrides: Partial<{
  id: string
  secret: string
  scopesJson: string
  status: "active" | "revoked"
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  lastUsedAt: string | null
}> = {}): Promise<void> {
  const id = overrides.id ?? "opc_seed"
  const status = overrides.status ?? "active"
  const createdAt = overrides.createdAt ?? "2026-06-28T00:00:00.000Z"
  const expiresAt = overrides.expiresAt ?? "2026-07-28T00:00:00.000Z"
  await client.execute({
    sql: `
      INSERT INTO operator_credentials (
        operator_credential_id, operator_actor_id, label, secret_hash, secret_hash_algo,
        secret_hash_version, scopes_json, status, created_at, expires_at, revoked_at, last_used_at
      ) VALUES (?1, 'svc_settlement_operator', 'Settlement operator', ?2, 'sha256',
        1, ?3, ?4, ?5, ?6, ?7, ?8)
    `,
    args: [
      id,
      hashOperatorCredentialSecret(overrides.secret ?? SECRET),
      overrides.scopesJson ?? JSON.stringify([BOOKING_SETTLEMENT_RESOLVE_SCOPE]),
      status,
      createdAt,
      expiresAt,
      overrides.revokedAt ?? null,
      overrides.lastUsedAt ?? null,
    ],
  })
}

async function lastUsedAt(client: Client, id = "opc_seed"): Promise<string | null> {
  const result = await client.execute({
    sql: "SELECT last_used_at FROM operator_credentials WHERE operator_credential_id = ?1",
    args: [id],
  })
  return String(result.rows[0]?.last_used_at ?? "") || null
}

describe("authenticateOperatorCredential", () => {
  test("local control-plane fixture migrations include operator_credentials", async () => {
    const previousCoreRepo = process.env.PIRATE_CORE_REPO
    process.env.PIRATE_CORE_REPO = new URL("../../test-fixtures", import.meta.url).pathname
    try {
      const db = await createControlPlaneTestClient({ includeAllMigrations: true })
      cleanups.push(db.cleanup)
      const result = await db.client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operator_credentials'",
        args: [],
      })
      expect(result.rows.length).toBe(1)
    } finally {
      if (previousCoreRepo === undefined) {
        delete process.env.PIRATE_CORE_REPO
      } else {
        process.env.PIRATE_CORE_REPO = previousCoreRepo
      }
    }
  })

  test("authenticates an active, unexpired operator credential and touches last_used_at", async () => {
    const { client, env } = await setup()
    await seedCredential(client)

    const actor = await authenticateOperatorCredential({
      env,
      authorization: `Operator opc_seed.${SECRET}`,
      now: () => Date.parse("2026-06-29T00:00:00.000Z"),
    })

    expect(actor).toEqual({
      authType: "operator_credential",
      operatorCredentialId: "opc_seed",
      operatorActorId: "svc_settlement_operator",
      scopes: [BOOKING_SETTLEMENT_RESOLVE_SCOPE],
    })
    expect(await lastUsedAt(client)).toBe("2026-06-29T00:00:00.000Z")
  })

  test("authenticates when the best-effort last_used_at touch fails", async () => {
    const executor: DbExecutor = {
      execute: async (query) => {
        const sql = typeof query === "string" ? query : query.sql
        if (sql.includes("FROM operator_credentials")) {
          return {
            rows: [{
              operator_credential_id: "opc_seed",
              operator_actor_id: "svc_settlement_operator",
              secret_hash: hashOperatorCredentialSecret(SECRET),
              secret_hash_algo: "sha256",
              secret_hash_version: 1,
              scopes_json: JSON.stringify([BOOKING_SETTLEMENT_RESOLVE_SCOPE]),
              status: "active",
              expires_at: "2026-07-28T00:00:00.000Z",
              last_used_at: null,
            }],
          }
        }
        throw new Error("simulated_touch_failure")
      },
    } as DbExecutor
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const actor = await authenticateOperatorCredential({
        env: {} as Env,
        executor,
        authorization: `Operator opc_seed.${SECRET}`,
        now: () => Date.parse("2026-06-29T00:00:00.000Z"),
      })
      expect(actor.operatorCredentialId).toBe("opc_seed")
      expect(warn).toHaveBeenCalledWith(
        "[operator-credential-auth] last_used_at touch failed",
        {
          operatorCredentialId: "opc_seed",
          code: "operator_credential_last_used_touch_failed",
        },
      )
    } finally {
      warn.mockRestore()
    }
  })

  test("rejects bad secret, revoked, and expired credentials", async () => {
    const badSecret = await setup()
    await seedCredential(badSecret.client)
    await expect(authenticateOperatorCredential({
      env: badSecret.env,
      authorization: "Operator opc_seed.wrong",
      now: () => Date.parse("2026-06-29T00:00:00.000Z"),
    })).rejects.toThrow("Authentication failed")

    const revoked = await setup()
    await seedCredential(revoked.client, {
      id: "opc_revoked",
      status: "revoked",
      revokedAt: "2026-06-28T01:00:00.000Z",
    })
    await expect(authenticateOperatorCredential({
      env: revoked.env,
      authorization: `Operator opc_revoked.${SECRET}`,
      now: () => Date.parse("2026-06-29T00:00:00.000Z"),
    })).rejects.toThrow("Authentication failed")

    const expired = await setup()
    await seedCredential(expired.client, { id: "opc_expired", expiresAt: "2026-06-29T00:00:00.000Z" })
    await expect(authenticateOperatorCredential({
      env: expired.env,
      authorization: `Operator opc_expired.${SECRET}`,
      now: () => Date.parse("2026-06-29T00:00:00.000Z"),
    })).rejects.toThrow("Authentication failed")
  })

  test("parses scopes_json strictly and fails closed", async () => {
    for (const [id, scopesJson] of [
      ["opc_bad_json", "not-json"],
      ["opc_not_array", JSON.stringify({ scope: BOOKING_SETTLEMENT_RESOLVE_SCOPE })],
      ["opc_empty", JSON.stringify([])],
      ["opc_unknown", JSON.stringify(["*"])],
      ["opc_duplicate", JSON.stringify([BOOKING_SETTLEMENT_RESOLVE_SCOPE, BOOKING_SETTLEMENT_RESOLVE_SCOPE])],
    ] as const) {
      const executor: DbExecutor = {
        execute: async (query) => {
          const sql = typeof query === "string" ? query : query.sql
          if (sql.includes("FROM operator_credentials")) {
            return {
              rows: [{
                operator_credential_id: id,
                operator_actor_id: "svc_settlement_operator",
                secret_hash: hashOperatorCredentialSecret(SECRET),
                secret_hash_algo: "sha256",
                secret_hash_version: 1,
                scopes_json: scopesJson,
                status: "active",
                expires_at: "2026-07-28T00:00:00.000Z",
                last_used_at: null,
              }],
            }
          }
          return { rows: [] }
        },
      } as DbExecutor
      await expect(authenticateOperatorCredential({
        env: {} as Env,
        executor,
        authorization: `Operator ${id}.${SECRET}`,
        now: () => Date.parse("2026-06-29T00:00:00.000Z"),
      })).rejects.toThrow("Authentication failed")
    }
  })

  test("rejects unsupported or malformed hash metadata", async () => {
    for (const [id, secretHashAlgo, secretHashVersion] of [
      ["opc_bad_algo", "md5", 1],
      ["opc_zero_version", "sha256", 0],
      ["opc_missing_version", "sha256", undefined],
    ] as const) {
      const executor: DbExecutor = {
        execute: async (query) => {
          const sql = typeof query === "string" ? query : query.sql
          if (sql.includes("FROM operator_credentials")) {
            return {
              rows: [{
                operator_credential_id: id,
                operator_actor_id: "svc_settlement_operator",
                secret_hash: hashOperatorCredentialSecret(SECRET),
                secret_hash_algo: secretHashAlgo,
                secret_hash_version: secretHashVersion,
                scopes_json: JSON.stringify([BOOKING_SETTLEMENT_RESOLVE_SCOPE]),
                status: "active",
                expires_at: "2026-07-28T00:00:00.000Z",
                last_used_at: null,
              }],
            }
          }
          return { rows: [] }
        },
      } as DbExecutor
      await expect(authenticateOperatorCredential({
        env: {} as Env,
        executor,
        authorization: `Operator ${id}.${SECRET}`,
        now: () => Date.parse("2026-06-29T00:00:00.000Z"),
      })).rejects.toThrow("Authentication failed")
    }
  })

  test("last_used_at update is throttled", async () => {
    const { client, env } = await setup()
    await seedCredential(client)
    await authenticateOperatorCredential({
      env,
      authorization: `Operator opc_seed.${SECRET}`,
      now: () => Date.parse("2026-06-29T00:00:00.000Z"),
    })
    await authenticateOperatorCredential({
      env,
      authorization: `Operator opc_seed.${SECRET}`,
      now: () => Date.parse("2026-06-29T00:03:00.000Z"),
    })
    expect(await lastUsedAt(client)).toBe("2026-06-29T00:00:00.000Z")
    await authenticateOperatorCredential({
      env,
      authorization: `Operator opc_seed.${SECRET}`,
      now: () => Date.parse("2026-06-29T00:06:00.000Z"),
    })
    expect(await lastUsedAt(client)).toBe("2026-06-29T00:06:00.000Z")
  })
})

describe("requireOperatorScope", () => {
  test("allows only an operator credential with the explicit settlement scope", () => {
    const actor: OperatorActorContext = {
      authType: "operator_credential",
      operatorCredentialId: "opc_seed",
      operatorActorId: "svc_settlement_operator",
      scopes: [BOOKING_SETTLEMENT_RESOLVE_SCOPE],
    }
    expect(() => requireOperatorScope(actor, BOOKING_SETTLEMENT_RESOLVE_SCOPE)).not.toThrow()
  })

  test("a generic admin token cannot satisfy money-resolution scope", () => {
    const admin = authenticateAdminToken({
      env: { PIRATE_ADMIN_TOKEN: "admin-secret" } as Env,
      token: "admin-secret",
      asUserId: "usr_admin",
    })
    expect(admin?.authType).toBe("admin")
    expect(() => requireOperatorScope(admin!, BOOKING_SETTLEMENT_RESOLVE_SCOPE)).toThrow("Operator credential is required")
  })
})
