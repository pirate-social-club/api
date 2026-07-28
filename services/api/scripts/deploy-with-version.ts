#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  buildStampedWranglerDeployArgs,
  resolveBuildVersionMetadata,
  validateSiblingWebCheckout,
} from "./deploy-version-args"

function runText(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
  })
  if (result.status !== 0) {
    const stderr = result.stderr.trim()
    throw new Error(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`)
  }
  return result.stdout.trim()
}

const apiRepoRoot = resolve(import.meta.dir, "../../..")
const webCheckout = resolve(apiRepoRoot, "../web")
const expectedWebSha = readFileSync(
  resolve(apiRepoRoot, ".github/ci-refs/web.sha"),
  "utf8",
)
validateSiblingWebCheckout(webCheckout, expectedWebSha, runText)

const metadata = resolveBuildVersionMetadata(process.env, runText)
const args = buildStampedWranglerDeployArgs(process.argv.slice(2), metadata)

console.info("[deploy] stamping Worker build", {
  git_ref: metadata.gitRef,
  git_sha: metadata.gitSha,
  build_timestamp: metadata.timestamp,
  community_d1_shard_source_version: metadata.communityD1ShardSourceVersion,
})

const child = spawn("wrangler", args, {
  stdio: "inherit",
})

const exitCode = await new Promise<number>((resolve) => {
  child.on("error", (error) => {
    console.error(error)
    resolve(1)
  })
  child.on("exit", (code) => {
    resolve(code ?? 1)
  })
})
process.exit(exitCode)
