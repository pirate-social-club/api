#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process"
import {
  buildStampedWranglerDeployArgs,
  resolveBuildVersionMetadata,
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
