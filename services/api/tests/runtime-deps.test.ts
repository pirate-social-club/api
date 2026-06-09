import { describe, expect, test } from "bun:test"
import { neonConfig } from "@neondatabase/serverless"
import { postgresifySql } from "../src/lib/runtime-deps"

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

describe("neonConfig.fetchEndpoint", () => {
  test("uses PlanetScale's SQL endpoint for PlanetScale Postgres hosts", () => {
    expect(neonConfig.fetchEndpoint("us-east-3.pg.psdb.cloud")).toBe("https://us-east-3.pg.psdb.cloud/sql")
  })
})
