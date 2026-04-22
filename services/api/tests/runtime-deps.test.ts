import { describe, expect, test } from "bun:test"
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
    expect(sql).toContain("$1")
    expect(sql).toContain("$2")
    expect(sql).not.toContain("INSERT OR REPLACE")
  })
})
