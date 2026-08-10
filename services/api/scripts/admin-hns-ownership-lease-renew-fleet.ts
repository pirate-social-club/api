#!/usr/bin/env bun

import type { Env } from "../src/env"
import { renewHnsOwnershipLeaseFleet } from "../src/lib/hns-root-observer/ownership-lease-renewal"
import { withStandaloneControlPlaneClient } from "../src/lib/runtime-deps"

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1]?.trim() : ""
  if (!value) throw new Error(`${flag} is required`)
  return value
}

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: bun run scripts/admin-hns-ownership-lease-renew-fleet.ts --actor ACTOR --reason REASON --verifier-base-url URL [--apply-renewals]",
  )
  process.exit(0)
}

if (args.includes("--apply")) {
  throw new Error("Use --apply-renewals; fleet mode never applies definitive negatives")
}

const databaseUrl = process.env.CONTROL_PLANE_MIGRATOR_DATABASE_URL?.trim()
  ?? process.env.CONTROL_PLANE_DATABASE_URL?.trim()
if (!databaseUrl) {
  throw new Error("CONTROL_PLANE_MIGRATOR_DATABASE_URL or CONTROL_PLANE_DATABASE_URL is required")
}

const env = {
  ...process.env,
  ENVIRONMENT: "operator",
  CONTROL_PLANE_DATABASE_URL: databaseUrl,
  HNS_VERIFIER_BASE_URL: process.env.HNS_VERIFIER_BASE_URL?.trim()
    || valueAfter(args, "--verifier-base-url"),
} as Env

const result = await withStandaloneControlPlaneClient(env, async (client) => {
  return await renewHnsOwnershipLeaseFleet({
    applyRenewals: args.includes("--apply-renewals"),
    client,
    env,
    operatorActorId: valueAfter(args, "--actor"),
    reason: valueAfter(args, "--reason"),
  })
})

console.log(JSON.stringify(result, null, 2))
if (result.counts.error > 0) process.exitCode = 1
