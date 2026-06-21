import { describe, expect, test } from "bun:test"
import { neonConfig } from "@neondatabase/serverless"
import {
  configurePostgresDriverForUrl,
  isPlanetScalePostgresUrl,
  normalizePostgresConnectionStringForDriver,
} from "./postgres-url.js"

const PSDB = "postgresql://role.br123:pw@us-east-3.pg.psdb.cloud:5432/postgres?sslmode=verify-full&sslrootcert=system"
const NEON = "postgresql://user:pw@example.neon.tech/postgres"

function resolveEndpoint(fn: unknown, host: string, port: number): string {
  return typeof fn === "function" ? (fn as (h: string, p: number) => string)(host, port) : String(fn)
}

describe("isPlanetScalePostgresUrl", () => {
  test("detects *.pg.psdb.cloud hosts only", () => {
    expect(isPlanetScalePostgresUrl(PSDB)).toBe(true)
    expect(isPlanetScalePostgresUrl(NEON)).toBe(false)
    expect(isPlanetScalePostgresUrl("file:/tmp/control-plane.db")).toBe(false)
    expect(isPlanetScalePostgresUrl("not a url")).toBe(false)
  })
})

describe("normalizePostgresConnectionStringForDriver", () => {
  test("strips sslrootcert=system for PlanetScale, keeps other params", () => {
    const out = new URL(normalizePostgresConnectionStringForDriver(PSDB))
    expect(out.searchParams.get("sslrootcert")).toBeNull()
    expect(out.searchParams.get("sslmode")).toBe("verify-full")
  })

  test("leaves non-PlanetScale URLs untouched", () => {
    const withParam = `${NEON}?sslrootcert=system`
    expect(normalizePostgresConnectionStringForDriver(withParam)).toBe(withParam)
  })
})

describe("configurePostgresDriverForUrl", () => {
  test("rewires the driver to PlanetScale endpoints", () => {
    configurePostgresDriverForUrl(PSDB)
    expect(resolveEndpoint(neonConfig.fetchEndpoint, "us-east-3.pg.psdb.cloud", 5432))
      .toBe("https://us-east-3.pg.psdb.cloud/sql")
    expect(resolveEndpoint(neonConfig.wsProxy, "us-east-3.pg.psdb.cloud", 5432))
      .toBe("us-east-3.pg.psdb.cloud/v2?address=us-east-3.pg.psdb.cloud:5432")
    expect(neonConfig.pipelineConnect).toBe(false)
  })

  test("resets driver config for non-PlanetScale URLs", () => {
    configurePostgresDriverForUrl(PSDB)
    configurePostgresDriverForUrl(NEON)
    // back off the PlanetScale-specific value (Neon default is not false)
    expect(neonConfig.pipelineConnect).not.toBe(false)
    expect(resolveEndpoint(neonConfig.wsProxy, "example.neon.tech", 5432)).not.toContain("address=")
  })
})
