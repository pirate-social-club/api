import { describe, expect, test } from "bun:test"
import { postgresifySql, resolveControlPlanePostgresConnectionString } from "../src/lib/runtime-deps"
import type { Env } from "../src/env"

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
