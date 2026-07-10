import { describe, expect, test } from "bun:test"
import {
  isPlanetScalePostgresUrl,
  normalizePostgresConnectionStringForDriver,
} from "./postgres-url.js"

const PSDB = "postgresql://role.br123:pw@us-east-3.pg.psdb.cloud:5432/postgres?sslmode=verify-full&sslrootcert=system"
const NON_PLANETSCALE = "postgresql://user:pw@postgres.example.com/postgres"

describe("isPlanetScalePostgresUrl", () => {
  test("detects *.pg.psdb.cloud hosts only", () => {
    expect(isPlanetScalePostgresUrl(PSDB)).toBe(true)
    expect(isPlanetScalePostgresUrl(NON_PLANETSCALE)).toBe(false)
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
    const withParam = `${NON_PLANETSCALE}?sslrootcert=system`
    expect(normalizePostgresConnectionStringForDriver(withParam)).toBe(withParam)
  })
})
