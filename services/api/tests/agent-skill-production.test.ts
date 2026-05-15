import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("production Pirate agent skill", () => {
  test("does not include staging-specific origins", () => {
    const files = [
      "docs/agents/pirate-agent-protocol/SKILL.md",
      "src/generated/pirate-agent-protocol-skill.ts",
    ]

    for (const file of files) {
      const body = readFileSync(resolve(file), "utf8")
      expect(body).not.toMatch(/api-staging|staging\.pirate/iu)
    }
  })
})
