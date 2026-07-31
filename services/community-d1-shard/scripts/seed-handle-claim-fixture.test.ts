import { describe, expect, test } from "bun:test"
import { seedCommand } from "./seed-handle-claim-fixture"

describe("seedCommand", () => {
  test("is pinned to the dedicated staging fixture database and checked-in SQL", () => {
    const command = seedCommand()
    expect(command.slice(0, 6)).toEqual([
      "bunx",
      "wrangler",
      "d1",
      "execute",
      "cmty-d1-fixture-staging",
      "--remote",
    ])
    expect(command).toContain("--file")
    expect(command.at(-1)).toEndWith("scripts/sql/seed-handle-claim-fixture.sql")
    expect(command).not.toContain("--command")
  })

})
