import { afterEach, describe, expect, test } from "bun:test"
import {
  getControlPlaneClient,
  postgresifySql,
  resolveControlPlanePostgresConnectionString,
  setControlPlanePostgresPoolFactoryForTests,
  withRequestControlPlaneClients,
} from "../src/lib/runtime-deps"
import type { Env } from "../src/env"

const POSTGRES_TEST_ENV = {
  CONTROL_PLANE_DATABASE_URL: "postgres://runtime-deadline.test/control",
  ENVIRONMENT: "test",
} as unknown as Env

type TestPostgresPool = ReturnType<
  NonNullable<Parameters<typeof setControlPlanePostgresPoolFactoryForTests>[0]>
>

function pendingQuery(): Promise<{ rows: unknown[]; rowCount: number }> {
  return new Promise(() => {})
}

afterEach(() => {
  setControlPlanePostgresPoolFactoryForTests(null)
})

describe("postgresifySql", () => {
  test("translates namespace verification upserts to PostgreSQL syntax", () => {
    const sql = postgresifySql(`
      INSERT OR REPLACE INTO namespace_verifications (
        namespace_verification_id, updated_at
      ) VALUES (?1, ?2)
    `)

    expect(sql).toContain("INSERT INTO namespace_verifications")
    expect(sql).toContain("ON CONFLICT (namespace_verification_id) DO UPDATE SET")
    expect(sql).toContain("updated_at = EXCLUDED.updated_at")
    expect(sql).not.toContain("namespace_verification_id = EXCLUDED.namespace_verification_id")
    expect(sql).toContain("$1")
    expect(sql).toContain("$2")
    expect(sql).not.toContain("INSERT OR REPLACE")
  })

  test("translates namespace capability upserts to PostgreSQL syntax", () => {
    const sql = postgresifySql(`
      INSERT OR REPLACE INTO namespace_verification_capabilities (
        capability_record_id, updated_at
      ) VALUES (?1, ?2)
    `)

    expect(sql).toContain("INSERT INTO namespace_verification_capabilities")
    expect(sql).toContain("ON CONFLICT (capability_record_id) DO UPDATE SET")
    expect(sql).toContain("updated_at = EXCLUDED.updated_at")
    expect(sql).not.toContain("capability_record_id = EXCLUDED.capability_record_id")
    expect(sql).toContain("$1")
    expect(sql).toContain("$2")
    expect(sql).not.toContain("INSERT OR REPLACE")
  })

  test("translates insert or ignore to PostgreSQL conflict no-op", () => {
    const sql = postgresifySql(`
      INSERT OR IGNORE INTO notification_receipts (event_id, recipient_user_id, created_at)
      VALUES (?1, ?2, ?3)
    `)

    expect(sql).toContain("INSERT INTO notification_receipts")
    expect(sql).toContain("ON CONFLICT DO NOTHING")
    expect(sql).toContain("$1")
    expect(sql).toContain("$2")
    expect(sql).toContain("$3")
    expect(sql).not.toContain("INSERT OR IGNORE")
  })

  test("rejects unlisted insert or replace tables", () => {
    expect(() => postgresifySql(`
      INSERT OR REPLACE INTO unknown_table (id, updated_at)
      VALUES (?1, ?2)
    `)).toThrow("Unsupported INSERT OR REPLACE table for PostgreSQL translation: unknown_table")
  })
})

describe("resolveControlPlanePostgresConnectionString", () => {
  test("uses Hyperdrive in production", () => {
    const env = {
      ENVIRONMENT: "production",
      CONTROL_PLANE_HYPERDRIVE: { connectionString: "postgres://hyperdrive.internal/control" },
    } as Env
    expect(resolveControlPlanePostgresConnectionString(env, "postgres://direct/control"))
      .toBe("postgres://hyperdrive.internal/control")
  })

  test("fails closed when the production binding is missing", () => {
    expect(() => resolveControlPlanePostgresConnectionString(
      { ENVIRONMENT: "production" } as Env,
      "postgres://direct/control",
    )).toThrow("Missing CONTROL_PLANE_HYPERDRIVE binding in production")
  })

  test("allows a direct pg URL outside production", () => {
    expect(resolveControlPlanePostgresConnectionString(
      { ENVIRONMENT: "staging" } as Env,
      "postgres://direct/control",
    )).toBe("postgres://direct/control")
  })
})

describe("PostgreSQL control-plane deadlines", () => {
  test("terminates the request-scoped connection when a statement exceeds the transport deadline", async () => {
    const queries: string[] = []
    let abortCalls = 0
    let endCalls = 0
    setControlPlanePostgresPoolFactoryForTests(() => ({
      statementTimeoutMs: 5,
      query: async (sql: string) => {
        queries.push(sql)
        return await pendingQuery()
      },
      abortPendingQuery: () => {
        abortCalls += 1
      },
      connect: async () => {
        throw new Error("transaction connection not expected")
      },
      end: async () => {
        endCalls += 1
      },
    }) as TestPostgresPool)

    await expect(withRequestControlPlaneClients(async () => {
      await getControlPlaneClient(POSTGRES_TEST_ENV).execute("SELECT 1")
    })).rejects.toThrow("statement SELECT did not settle within 5ms")

    expect(queries).toEqual(["SELECT 1"])
    expect(abortCalls).toBe(1)
    expect(endCalls).toBe(1)
  })

  for (const finalizer of ["commit", "rollback"] as const) {
    test(`bounds and terminates a stalled transaction ${finalizer}`, async () => {
      const queries: string[] = []
      let abortCalls = 0
      const finalizerSql = finalizer.toUpperCase()
      const transactionConnection = {
        statementTimeoutMs: 5,
        query: async (sql: string) => {
          queries.push(sql)
          return sql === finalizerSql ? await pendingQuery() : { rows: [], rowCount: 0 }
        },
        abortPendingQuery: () => {
          abortCalls += 1
        },
        release: () => {},
      }
      setControlPlanePostgresPoolFactoryForTests(() => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        connect: async () => transactionConnection,
        end: async () => {},
      }) as TestPostgresPool)

      await expect(withRequestControlPlaneClients(async () => {
        const transaction = await getControlPlaneClient(POSTGRES_TEST_ENV).transaction()
        try {
          if (finalizer === "commit") {
            await transaction.commit()
          } else {
            await transaction.rollback()
          }
        } finally {
          transaction.close()
        }
      })).rejects.toThrow(`statement ${finalizerSql} did not settle within 5ms`)

      expect(queries).toEqual([
        "BEGIN",
        "SET LOCAL statement_timeout = 5",
        "SET LOCAL idle_in_transaction_session_timeout = 10",
        finalizerSql,
      ])
      expect(abortCalls).toBe(1)
    })
  }

  test("terminates a transaction connection when the server rejects commit", async () => {
    let abortCalls = 0
    const transactionConnection = {
      query: async (sql: string) => {
        if (sql === "COMMIT") throw new Error("server canceled commit")
        return { rows: [], rowCount: 0 }
      },
      abortPendingQuery: () => {
        abortCalls += 1
      },
      release: () => {},
    }
    setControlPlanePostgresPoolFactoryForTests(() => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => transactionConnection,
      end: async () => {},
    }) as TestPostgresPool)

    await expect(withRequestControlPlaneClients(async () => {
      const transaction = await getControlPlaneClient(POSTGRES_TEST_ENV).transaction()
      try {
        await transaction.commit()
      } finally {
        transaction.close()
      }
    })).rejects.toThrow("server canceled commit")

    expect(abortCalls).toBe(1)
  })
})
