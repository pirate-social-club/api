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
  test("accepts a scoped operator credential from reusable-workflow callers", async () => {
    const workflow = await readFile(workflowPath, "utf8")

    expect(workflow).toContain("PIRATE_ADMIN_OPERATOR_CREDENTIAL:\n        required: false")
    expect(workflow).toContain(
      "PIRATE_ADMIN_OPERATOR_CREDENTIAL: ${{ secrets.PIRATE_ADMIN_OPERATOR_CREDENTIAL }}",
    )
  })

  test("keeps public-comment inventory wired into the mobile execution grep", async () => {
    const workflow = await readFile(workflowPath, "utf8")
    const requiredTitles = [
      "comments on a public thread without joining first",
      "keeps public-thread commenting available while membership is unknown",
    ]

    for (const title of requiredTitles) {
      expect(occurrences(workflow, title)).toBe(1)
    }

    expect(workflow).toContain('echo "MOBILE_CONTRACT_GREP=$mobile_contract_grep" >> "$GITHUB_ENV"')
    expect(workflow).toContain('--grep "$MOBILE_CONTRACT_GREP"')

    expect(workflow).not.toContain("joins from the comment CTA before exposing the mobile composer")
    expect(workflow).not.toContain("keeps the composer visible but disabled while membership is unknown")
  })

  // The live suite includes multipart, whose test sets its own timeout. Assert
  // the ordering rather than literal numbers so either ceiling can move safely.
  test("keeps CI ceilings above the multipart test's own timeout", async () => {
    const workflow = await readFile(workflowPath, "utf8")

    const liveContractStep = workflow
      .split("- name: Verify live staging contracts")[1]
      ?.split("- name:")[0]
    expect(liveContractStep, "live staging contract step").toBeTruthy()

    const stepCeiling = Number(liveContractStep?.match(/timeout-minutes:\s*(\d+)/u)?.[1])
    const jobCeiling = Number(workflow.match(/timeout-minutes:\s*(\d+)/u)?.[1])

    // Mirrors testInfo.setTimeout(15 * 60_000) in web's e2e/live-staging.live.spec.ts.
    // If that value rises above this, the step ceiling must rise with it.
    const testTimeoutMinutes = 15
    const teardownMarginMinutes = 5

    expect(stepCeiling).toBeGreaterThanOrEqual(testTimeoutMinutes + teardownMarginMinutes)
    // The job ceiling must leave room for the step plus the failure-path artifact
    // upload; a job-level kill uploads nothing.
    expect(jobCeiling).toBeGreaterThan(stepCeiling)
  })

  test("uploads the Playwright report on the failure path", async () => {
    const workflow = await readFile(workflowPath, "utf8")
    const uploadStep = workflow.split("- name: Upload Playwright report")[1]?.split("- name:")[0]
    expect(uploadStep, "Playwright report upload step").toBeTruthy()
    expect(uploadStep).toMatch(/if:\s*(failure\(\)|always\(\))/u)
  })
})
