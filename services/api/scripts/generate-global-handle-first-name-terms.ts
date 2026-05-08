import { execFile } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

type NameStats = {
  term: string
  latestCount: number
  latestRank: number
  totalCount: number
  totalRank: number
  multiplier: number
}

function readArg(name: string, fallback: string): string {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1] ?? fallback
}

async function runText(command: string[]): Promise<string> {
  const [binary, ...args] = command
  if (!binary) {
    throw new Error("Command is required")
  }
  try {
    const { stdout } = await execFileAsync(binary, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : String(error)
    throw new Error(`${command.join(" ")} failed: ${stderr}`)
  }
}

function normalizeName(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z]{3,12}$/u.test(normalized)) return null
  return normalized
}

function rankByCount(entries: Array<{ term: string; count: number }>): Map<string, number> {
  return new Map(
    entries
      .sort((left, right) => right.count - left.count || left.term.localeCompare(right.term))
      .map((entry, index) => [entry.term, index + 1] as const),
  )
}

function multiplierForRank(input: {
  latestRank: number
  totalRank: number
}): number {
  const latestMultiplier =
    input.latestRank <= 10 ? 12
      : input.latestRank <= 25 ? 10
        : input.latestRank <= 50 ? 8
          : input.latestRank <= 100 ? 6
            : input.latestRank <= 250 ? 4
              : input.latestRank <= 500 ? 3
                : 1
  const totalMultiplier =
    input.totalRank <= 25 ? 8
      : input.totalRank <= 100 ? 6
        : input.totalRank <= 250 ? 4
          : input.totalRank <= 500 ? 3
            : 1
  return Math.max(latestMultiplier, totalMultiplier)
}

function serializeTerm(entry: NameStats, latestYear: number): string {
  return `  { term: ${JSON.stringify(entry.term)}, type: "first_name", multiplier: ${entry.multiplier}, source_note: ${JSON.stringify(`SSA national names through ${latestYear}; latest_rank=${entry.latestRank}; total_rank=${entry.totalRank}`)} },`
}

async function main(): Promise<void> {
  const zipPath = resolve(readArg("--zip", "/tmp/ssa-names.zip"))
  const outputPath = resolve(readArg(
    "--out",
    "src/lib/auth/global-handle-first-name-terms.ts",
  ))
  const maxTerms = Number(readArg("--max-terms", "650"))
  if (!Number.isInteger(maxTerms) || maxTerms <= 0) {
    throw new Error("--max-terms must be a positive integer")
  }

  const zipListing = await runText(["unzip", "-Z", "-1", zipPath])
  const yearFiles = zipListing
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^yob\d{4}\.txt$/u.test(line))
    .sort()
  if (yearFiles.length === 0) {
    throw new Error("No yobYYYY.txt files found in names zip")
  }
  const latestFile = yearFiles.at(-1) ?? ""
  const latestYear = Number(latestFile.match(/\d{4}/u)?.[0] ?? "")
  if (!Number.isInteger(latestYear)) {
    throw new Error("Could not determine latest SSA year")
  }

  const latestCounts = new Map<string, number>()
  const totalCounts = new Map<string, number>()

  for (const file of yearFiles) {
    const text = await runText(["unzip", "-p", zipPath, file])
    for (const line of text.split(/\r?\n/u)) {
      if (!line) continue
      const [rawName, , rawCount] = line.split(",")
      const term = normalizeName(rawName ?? "")
      const count = Number(rawCount)
      if (!term || !Number.isFinite(count) || count <= 0) continue
      totalCounts.set(term, (totalCounts.get(term) ?? 0) + count)
      if (file === latestFile) {
        latestCounts.set(term, (latestCounts.get(term) ?? 0) + count)
      }
    }
  }

  const latestRanks = rankByCount([...latestCounts].map(([term, count]) => ({ term, count })))
  const totalRanks = rankByCount([...totalCounts].map(([term, count]) => ({ term, count })))

  const candidates = new Set<string>()
  for (const [term, rank] of latestRanks) {
    if (rank <= 500) candidates.add(term)
  }
  for (const [term, rank] of totalRanks) {
    if (rank <= 500) candidates.add(term)
  }

  const terms = [...candidates]
    .map((term): NameStats => {
      const latestRank = latestRanks.get(term) ?? Number.MAX_SAFE_INTEGER
      const totalRank = totalRanks.get(term) ?? Number.MAX_SAFE_INTEGER
      return {
        term,
        latestCount: latestCounts.get(term) ?? 0,
        latestRank,
        totalCount: totalCounts.get(term) ?? 0,
        totalRank,
        multiplier: multiplierForRank({ latestRank, totalRank }),
      }
    })
    .filter((entry) => entry.multiplier > 1)
    .sort((left, right) => (
      right.multiplier - left.multiplier
      || Math.min(left.latestRank, left.totalRank) - Math.min(right.latestRank, right.totalRank)
      || left.term.localeCompare(right.term)
    ))
    .slice(0, maxTerms)
    .sort((left, right) => left.term.localeCompare(right.term))

  const contents = `// Generated by scripts/generate-global-handle-first-name-terms.ts.
// Source: SSA national baby-name data, mirrored from names.zip.
// Algorithm: exact ASCII name matches only; multiplier is based on latest-year rank and historical total rank.
// Regenerate with: rtk bun scripts/generate-global-handle-first-name-terms.ts --zip /path/to/names.zip

import type { GlobalHandlePremiumTerm } from "./global-handle-premium-terms"

export const GLOBAL_HANDLE_FIRST_NAME_TERMS = [
${terms.map((entry) => serializeTerm(entry, latestYear)).join("\n")}
] as const satisfies readonly GlobalHandlePremiumTerm[]
`

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, contents)
  console.log(JSON.stringify({
    latestYear,
    terms: terms.length,
    outputPath,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
