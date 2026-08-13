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
  test("accepts the caller operator credential before using the legacy fallback", async () => {
    const workflow = await readFile(workflowPath, "utf8")

    expect(workflow).toMatch(
      /secrets:\s*[\s\S]*?PIRATE_ADMIN_OPERATOR_CREDENTIAL:\s*\n\s+required: false/u,
    )
    expect(workflow).toContain(
      "PIRATE_ADMIN_OPERATOR_CREDENTIAL: ${{ secrets.PIRATE_ADMIN_OPERATOR_CREDENTIAL }}",
    )
    expect(workflow).toContain(
      "if: env.AUTH_UPSTREAM_JWT_SHARED_SECRET == '' || env.PIRATE_ADMIN_OPERATOR_CREDENTIAL == ''",
    )
    expect(workflow).toContain(
      'credential="opc_admin_automation.${PIRATE_ADMIN_TOKEN}"',
    )
  })

  test("keeps the production verifier probe in its dedicated workflow", async () => {
    const workflow = await readFile(workflowPath, "utf8")
    expect(workflow).not.toContain("Fetch the production HNS verifier observer credential")
    expect(workflow).not.toContain("HNS_VERIFIER_BASE_URL: https://verifier.pirate.sc/hns")
  })

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

  // The multipart contract is the one step whose test sets its own timeout, so it
  // is the one step where the CI ceiling can invert below the test and swallow
  // every diagnostic. Assert the ordering rather than the literal numbers, so
  // either side can move as long as the relationship survives.
  test("keeps CI ceilings above the multipart test's own timeout", async () => {
    const workflow = await readFile(workflowPath, "utf8")

    const multipartStep = workflow
      .split("- name: Verify direct multipart upload contract")[1]
      ?.split("- name:")[0]
    expect(multipartStep, "multipart contract step").toBeTruthy()

    const stepCeiling = Number(multipartStep?.match(/timeout-minutes:\s*(\d+)/u)?.[1])
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
