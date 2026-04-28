import { describe, expect, test } from "bun:test"
import {
  hasCheckConstraintName,
  hasUniqueConstraintName,
  normalizeControlPlaneDbUrl,
} from "./auth-db-query-helpers"

describe("hasUniqueConstraintName", () => {
  test("recognizes exposed PostgreSQL constraint names", () => {
    const error = {
      code: "23505",
      constraint: "idx_wallet_attachments_active_primary",
    }

    expect(hasUniqueConstraintName(error, "idx_wallet_attachments_active_primary")).toBe(true)
  })

  test("recognizes PostgreSQL constraint names in error messages", () => {
    const error = new Error('duplicate key value violates unique constraint "idx_wallet_attachments_active_primary"')

    expect(hasUniqueConstraintName(error, "idx_wallet_attachments_active_primary")).toBe(true)
  })
})

describe("hasCheckConstraintName", () => {
  test("recognizes exposed PostgreSQL check constraint names", () => {
    const error = {
      code: "23514",
      constraint: "namespace_verification_sessions_status_check",
    }

    expect(hasCheckConstraintName(error, "namespace_verification_sessions_status_check")).toBe(true)
  })

  test("recognizes PostgreSQL check constraint names in error messages", () => {
    const error = new Error(
      'new row for relation "namespace_verification_sessions" violates check constraint "namespace_verification_sessions_status_check"',
    )

    expect(hasCheckConstraintName(error, "namespace_verification_sessions_status_check")).toBe(true)
  })
})

describe("normalizeControlPlaneDbUrl", () => {
  test("preserves Postgres TLS parameters", () => {
    const url = "postgresql://control_plane_api_rw:secret@example.neon.tech/pirate?sslmode=require&channel_binding=require"

    expect(normalizeControlPlaneDbUrl(url)).toBe(url)
  })

  test("strips libsql-unsupported TLS parameters from non-Postgres URLs", () => {
    expect(normalizeControlPlaneDbUrl("libsql://example.turso.io?sslmode=require&channel_binding=require&foo=bar"))
      .toBe("libsql://example.turso.io?foo=bar")
  })
})
