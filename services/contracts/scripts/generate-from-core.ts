import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveCoreRepoRoot } from "./core-paths.js"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const contractsDir = resolve(scriptDir, "..")
const repoRoot = resolve(contractsDir, "..", "..")
const coreRepoRoot = resolveCoreRepoRoot(repoRoot)
const generatorPath = resolve(coreRepoRoot, "specs/api/scripts/generate-api-contracts.ts")
const outputPath = resolve(contractsDir, "src/index.ts")

const result = spawnSync("bun", [generatorPath], {
  cwd: coreRepoRoot,
  env: {
    ...process.env,
    API_CONTRACTS_OUTPUT_FILE: outputPath,
  },
  stdio: "inherit",
})

process.exit(result.status ?? 1)
