import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveCoreRepoRoot } from "./core-paths.js"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const contractsDir = resolve(scriptDir, "..")
const repoRoot = resolve(contractsDir, "..", "..")
const coreRepoRoot = resolveCoreRepoRoot(repoRoot)
const generatorPath = resolve(coreRepoRoot, "specs/api/scripts/generate-api-contracts.ts")
const generatedFile = resolve(contractsDir, "src/index.ts")

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), "pirate-contracts-fresh-"))
  const tempOutput = join(tempDir, "index.ts")

  try {
    const proc = Bun.spawn({
      cmd: ["bun", generatorPath],
      cwd: coreRepoRoot,
      env: {
        ...process.env,
        API_CONTRACTS_OUTPUT_FILE: tempOutput,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode !== 0) {
      process.stderr.write(stderr || stdout)
      process.exit(exitCode)
    }

    const [expected, actual] = await Promise.all([
      readFile(tempOutput, "utf8"),
      readFile(generatedFile, "utf8"),
    ])

    if (expected !== actual) {
      process.stderr.write(
        [
          "Generated contracts are stale.",
          "Run `rtk bun run generate` from services/contracts and commit the updated output.",
          "",
        ].join("\n"),
      )
      process.exit(1)
    }

    process.stdout.write("Generated contracts are up to date.\n")
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

await main()
