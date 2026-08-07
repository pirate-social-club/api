#!/usr/bin/env bun

import { activateHnsRootRouting } from "../src/lib/hns-root-observer/activation"
import { getControlPlaneClient } from "../src/lib/runtime-deps"
import type { Env } from "../src/env"

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1]?.trim() : ""
  if (!value) throw new Error(`${flag} is required`)
  return value
}

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun run scripts/admin-hns-root-activate.ts --root ROOT --actor ACTOR --reason REASON")
  process.exit(0)
}

const databaseUrl = process.env.CONTROL_PLANE_MIGRATOR_DATABASE_URL?.trim()
  ?? process.env.CONTROL_PLANE_DATABASE_URL?.trim()
if (!databaseUrl) throw new Error("CONTROL_PLANE_MIGRATOR_DATABASE_URL or CONTROL_PLANE_DATABASE_URL is required")

const env = {
  ENVIRONMENT: process.env.ENVIRONMENT ?? "production",
  CONTROL_PLANE_DATABASE_URL: databaseUrl,
} as Env
const client = getControlPlaneClient(env)
try {
  const result = await activateHnsRootRouting(client, {
    rootLabel: valueAfter(args, "--root"),
    operatorActorId: valueAfter(args, "--actor"),
    reason: valueAfter(args, "--reason"),
  })
  console.log(JSON.stringify(result, null, 2))
} finally {
  await client.close?.()
}
