import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const workflowPath = new URL(
  "../../../../.github/workflows/staging-contract-gate.yml",
  import.meta.url,
)

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe("staging contract gate workflow", () => {
  test("keeps public-comment inventory and execution titles aligned", async () => {
    const workflow = await readFile(workflowPath, "utf8")
    const requiredTitles = [
      "comments on a public thread without joining first",
      "keeps public-thread commenting available while membership is unknown",
    ]

    for (const title of requiredTitles) {
      expect(occurrences(workflow, title)).toBe(2)
    }

    expect(workflow).not.toContain("joins from the comment CTA before exposing the mobile composer")
    expect(workflow).not.toContain("keeps the composer visible but disabled while membership is unknown")
  })
})
