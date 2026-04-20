import { describe, expect, test } from "bun:test"
import { isMissingColumnError } from "./auth-db-query-helpers"

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
