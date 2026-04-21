import { describe, expect, test } from "bun:test"
import { hasUniqueConstraintName, isMissingColumnError } from "./auth-db-query-helpers"

describe("isMissingColumnError", () => {
  test("recognizes PostgreSQL undefined-column messages without an exposed code", () => {
    const error = new Error('column "upvote_count" does not exist')

    expect(isMissingColumnError(error, "upvote_count")).toBe(true)
  })

  test("recognizes SQLite missing-column messages", () => {
    const error = new Error("no such column: visibility")

    expect(isMissingColumnError(error, "visibility")).toBe(true)
  })
})

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
