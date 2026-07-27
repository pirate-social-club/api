#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

import { loadReviewedRehearsalManifest } from "./manifest"
import { runRehearsalPreflight } from "./preflight"
import { RehearsalRpcReader } from "./reader"

type Args = {
  manifest: string
  archiveRoot: string
  rpcUrl: string
  output: string
  payoutsPaused: boolean
  refundsPaused: boolean
}

function fail(message: string): never {
  throw new Error(`rehearsal preflight: ${message}`)
}

function parseBoolean(value: string | undefined, field: string): boolean {
  if (value === "true") return true
  if (value === "false") return false
  return fail(`${field} must be true or false`)
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("arguments must be --name value pairs")
    }
    if (values.has(key)) fail(`${key} was supplied more than once`)
    values.set(key, value)
  }
  const required = (key: string) => values.get(key) ?? fail(`${key} is required`)
  return {
    manifest: required("--manifest"),
    archiveRoot: required("--archive-root"),
    rpcUrl: required("--rpc-url"),
    output: required("--output"),
    payoutsPaused: parseBoolean(values.get("--payouts-paused"), "--payouts-paused"),
    refundsPaused: parseBoolean(values.get("--refunds-paused"), "--refunds-paused"),
  }
}

function assertInside(root: string, candidate: string, field: string): string {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const pathFromRoot = relative(resolvedRoot, resolvedCandidate)
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || resolve(resolvedRoot, pathFromRoot) !== resolvedCandidate) {
    fail(`${field} must be a file inside --archive-root`)
  }
  return resolvedCandidate
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  const archiveRoot = resolve(args.archiveRoot)
  const manifestPath = assertInside(archiveRoot, args.manifest, "--manifest")
  const outputPath = assertInside(archiveRoot, args.output, "--output")
  if (!existsSync(manifestPath)) fail("--manifest does not exist")
  if (existsSync(outputPath)) fail("--output already exists; evidence is append-only")
  if (dirname(outputPath) !== archiveRoot) {
    fail("--output must be written directly in --archive-root")
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown
  const manifest = loadReviewedRehearsalManifest(raw, archiveRoot)
  const reader = RehearsalRpcReader.create({ rpcUrl: args.rpcUrl })
  const evidence = await runRehearsalPreflight({
    manifest,
    reader,
    expectedPauseState: {
      payoutsPaused: args.payoutsPaused,
      refundsPaused: args.refundsPaused,
    },
  })
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" })
  process.stdout.write(`PREFLIGHT PASSED — ${evidence.checks.length}/${evidence.checks.length}\n`)
  process.stdout.write(`${outputPath}\n`)
}

if (import.meta.main) {
  await main()
}
