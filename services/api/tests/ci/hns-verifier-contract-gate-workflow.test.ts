import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const workflowPath = new URL(
  "../../../../.github/workflows/hns-verifier-contract-gate.yml",
  import.meta.url,
)

describe("HNS verifier contract gate workflow", () => {
  test("is an independent short read-only probe", async () => {
    const workflow = await readFile(workflowPath, "utf8")

    expect(workflow).toContain("name: hns-verifier-contract-gate")
    expect(workflow).toContain("name: HNS verifier raw-record contract")
    expect(workflow).toContain("timeout-minutes: 5")
    expect(workflow).not.toMatch(/^\s+needs:/mu)
    expect(workflow).toContain("HNS_VERIFIER_BASE_URL: https://verifier.pirate.sc/hns")
    expect(workflow).toContain("HNS_VERIFIER_CONTRACT_ROOT_LABEL: tame_impala")
    expect(workflow).toContain("SECRET_NAMES: HNS_VERIFIER_AUTH_TOKEN")
  })
})
