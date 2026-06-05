import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

type TimingKind = "song-public" | "song-locked" | "video-public" | "video-locked"

const defaultKinds: TimingKind[] = ["video-public", "video-locked", "song-locked"]

function readFlag(name: string): string | null {
  const prefix = `${name}=`
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function printUsage(): void {
  console.log(`
Usage:
  bun run timing:local-runs --community-id cmt_...

Runs the local timing methodology set against an already-running API:
  video-public
  video-locked
  song-locked

Common options:
  --api-base-url <url>    Defaults to PIRATE_TIMING_API_BASE_URL or http://127.0.0.1:8787.
  --community-id <id>     Defaults to PIRATE_TIMING_COMMUNITY_ID.
  --kinds <csv>           Defaults to video-public,video-locked,song-locked.
  --runs <n>              Defaults to PIRATE_TIMING_RUNS or 1.
  --warmup-runs <n>       Defaults to PIRATE_TIMING_WARMUP_RUNS or 0.
  --label <name>          Output label. Defaults to current.
  --output-dir <path>     Defaults to scripts/generated-timing-runs/<label>.

Notes:
  This does not start or restart the API server.
  To A/B sync vs async locally, run this once against the current server, restart the server with
  STORY_LOCKED_DELIVERY_ASYNC=true, then run it again with --label async.
`)
}

function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "")
}

function isLocalApiUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname === "127.0.0.1" || url.hostname === "localhost"
  } catch {
    return false
  }
}

function readKinds(): TimingKind[] {
  const raw = readFlag("--kinds") || defaultKinds.join(",")
  const kinds = raw.split(",").map((kind) => kind.trim()).filter(Boolean)
  for (const kind of kinds) {
    if (!["song-public", "song-locked", "video-public", "video-locked"].includes(kind)) {
      throw new Error(`Unsupported timing kind: ${kind}`)
    }
  }
  return kinds as TimingKind[]
}

async function runCommand(command: string[], env?: Record<string, string>): Promise<void> {
  console.log(`[timing:local-runs] ${command.join(" ")}`)
  const executable = command[0]
  if (!executable) throw new Error("runCommand requires a non-empty command")
  await new Promise<void>((resolvePromise, reject) => {
    const proc = spawn(executable, command.slice(1), {
      env: {
        ...process.env,
        ...env,
      },
      stdio: "inherit",
    })
    proc.on("error", reject)
    proc.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command.join(" ")} exited with ${exitCode}`))
    })
  })
}

async function ensureFixtures(): Promise<void> {
  const required = [
    "scripts/generated-fixtures/4mb.wav",
    "scripts/generated-fixtures/4mb.mp4",
    "scripts/generated-fixtures/poster.jpg",
  ]
  if (required.every((path) => existsSync(path))) return
  await runCommand(["bun", "run", "scripts/generate-timing-fixtures.ts"])
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage()
    return
  }

  const apiBaseUrl = normalizeApiBaseUrl(
    readFlag("--api-base-url")
      || process.env.PIRATE_TIMING_API_BASE_URL
      || "http://127.0.0.1:8787",
  )
  const communityId = readFlag("--community-id") || process.env.PIRATE_TIMING_COMMUNITY_ID
  if (!communityId) {
    throw new Error("--community-id or PIRATE_TIMING_COMMUNITY_ID is required")
  }
  const runs = readFlag("--runs") || process.env.PIRATE_TIMING_RUNS || "1"
  const warmupRuns = readFlag("--warmup-runs") || process.env.PIRATE_TIMING_WARMUP_RUNS || "0"
  const label = readFlag("--label") || "current"
  const outputDir = resolve(readFlag("--output-dir") || `scripts/generated-timing-runs/${label}`)
  const kinds = readKinds()
  const local = isLocalApiUrl(apiBaseUrl)
  await mkdir(outputDir, { recursive: true })
  await ensureFixtures()

  console.log("[timing:local-runs] config", {
    apiBaseUrl,
    communityId,
    kinds,
    runs,
    warmupRuns,
    outputDir,
    skip_owner_access: local,
  })

  for (const kind of kinds) {
    const args = [
      "bun",
      "run",
      "scripts/timing-submission-e2e.ts",
      "--file",
      kind.startsWith("song-") ? "scripts/generated-fixtures/4mb.wav" : "scripts/generated-fixtures/4mb.mp4",
      "--output",
      resolve(outputDir, `${kind}.jsonl`),
    ]
    if (kind.startsWith("video-")) {
      args.push("--poster-file", "scripts/generated-fixtures/poster.jpg")
    }
    if (local) {
      args.push("--skip-owner-access")
    }
    await runCommand(args, {
      PIRATE_TIMING_API_BASE_URL: apiBaseUrl,
      PIRATE_TIMING_COMMUNITY_ID: communityId,
      PIRATE_TIMING_KIND: kind,
      PIRATE_TIMING_RUNS: runs,
      PIRATE_TIMING_WARMUP_RUNS: warmupRuns,
    })
  }
}

main().catch((error) => {
  console.error("[timing:local-runs] failed", error)
  process.exit(1)
})
