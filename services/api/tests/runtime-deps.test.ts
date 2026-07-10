import { describe, expect, test } from "bun:test"
import { neonConfig } from "@neondatabase/serverless"
import {
  configureWorkerPostgresTransportForUrl,
  getControlPlaneClient,
  postgresifySql,
} from "../src/lib/runtime-deps"
import type { Env } from "../src/env"

// The transport package's config singleton is configured per control-plane URL (just before each
// connection opens), not globally at module load — so drive it with a
// PlanetScale Postgres URL the way the open path does before asserting.
const PLANETSCALE_URL = "postgres://user:pass@us-east-3.pg.psdb.cloud/control"

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

describe("control-plane transport selection", () => {
  test("rejects non-Postgres URLs outside the explicit test environment", () => {
    expect(() => getControlPlaneClient({
      CONTROL_PLANE_DATABASE_URL: "file:/tmp/control-plane.db",
      ENVIRONMENT: "production",
    } as Env)).toThrow("Non-Postgres control-plane URLs are supported only by the explicit test adapter")
  })
})

describe("Worker Postgres transport HTTP endpoint", () => {
  test("uses PlanetScale's SQL endpoint for PlanetScale Postgres hosts", () => {
    configureWorkerPostgresTransportForUrl(PLANETSCALE_URL)
    const fetchEndpoint = neonConfig.fetchEndpoint
    expect(typeof fetchEndpoint).toBe("function")
    expect(typeof fetchEndpoint === "function" ? fetchEndpoint("us-east-3.pg.psdb.cloud", 5432) : null)
      .toBe("https://us-east-3.pg.psdb.cloud/sql")
  })
})

describe("Worker Postgres transport WebSocket settings", () => {
  test("uses PlanetScale's WebSocket proxy for interactive transactions", () => {
    configureWorkerPostgresTransportForUrl(PLANETSCALE_URL)
    const wsProxy = neonConfig.wsProxy
    expect(neonConfig.pipelineConnect).toBe(false)
    expect(typeof wsProxy).toBe("function")
    expect(typeof wsProxy === "function" ? wsProxy("us-east-3.pg.psdb.cloud", 5432) : null)
      .toBe("us-east-3.pg.psdb.cloud/v2?address=us-east-3.pg.psdb.cloud:5432")
  })
})
