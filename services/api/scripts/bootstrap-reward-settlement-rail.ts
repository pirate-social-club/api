#!/usr/bin/env bun

// Operator CLI for binding one settlement rail per environment. See
// docs/runbooks/reward-settlement-rail-bootstrap.md for the procedure and
// evidence conventions. Requires a privileged database credential; the API's
// SELECT-only role cannot perform this action by construction.

import { SQL } from "bun"

import {
  describeDatabaseTarget,
  executeSettlementRailBootstrap,
  planSettlementRailBootstrap,
  SettlementRailBootstrapError,
} from "../src/lib/rewards/reward-settlement-rail-bootstrap"

function usage(): never {
  console.error(`Usage:
  bun scripts/bootstrap-reward-settlement-rail.ts \\
    --database-url-env ENV_NAME \\
    --environment local|staging|production \\
    --backend local|eoa_vault|lit_vault \\
    --chain-id N --token-address 0x... \\
    --treasury-address 0x... --operator-address 0x... \\
    --executor PRINCIPAL \\
    [--vault-address 0x...] [--policy-version v1] [--dry-run]

The database URL is read from the named environment variable so credentials
never appear on the command line. The connection must hold INSERT on
reward_settlement_rails (admin/migrator credential, not the API role).`)
  process.exit(1)
}

function parseArgs(argv: string[]): { values: Record<string, string>; dryRun: boolean } {
  const values: Record<string, string> = {}
  let dryRun = false
  for (let index = 0; index < argv.length; ) {
    const arg = argv[index]
    if (arg === "--dry-run") {
      dryRun = true
      index += 1
      continue
    }
    if (arg === "-h" || arg === "--help" || !arg?.startsWith("--")) usage()
    const value = argv[index + 1]
    if (value === undefined) usage()
    values[arg.slice(2)] = value
    index += 2
  }
  return { values, dryRun }
}

async function main(): Promise<void> {
  const { values, dryRun } = parseArgs(process.argv.slice(2))
  for (const required of [
    "database-url-env",
    "environment",
    "backend",
    "chain-id",
    "token-address",
    "treasury-address",
    "operator-address",
    "executor",
  ]) {
    if (!values[required]) {
      console.error(`missing --${required}`)
      usage()
    }
  }

  const databaseUrl = String(process.env[values["database-url-env"] as string] ?? "").trim()
  if (!databaseUrl) {
    console.error(`environment variable ${values["database-url-env"]} is empty; refusing to run`)
    process.exit(1)
  }
  const executor = String(values.executor ?? "").trim()
  if (!executor || executor.length > 200 || /[\u0000-\u001f\u007f]/.test(executor)) {
    console.error("--executor must be a non-empty principal of at most 200 printable characters")
    process.exit(1)
  }

  const randomBytes = new Uint8Array(4)
  crypto.getRandomValues(randomBytes)
  const plan = planSettlementRailBootstrap({
    environment: values.environment as string,
    backend: values.backend as string,
    chainId: values["chain-id"] as string,
    tokenAddress: values["token-address"] as string,
    treasuryAddress: values["treasury-address"] as string,
    operatorAddress: values["operator-address"] as string,
    vaultAddress: values["vault-address"] ?? null,
    policyVersion: values["policy-version"],
    randomHex: Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  })

  const sql = new SQL({ url: databaseUrl, max: 1, connectionTimeout: 10 } as Record<string, unknown>)
  try {
    await sql.unsafe("BEGIN")
    let outcome
    try {
      outcome = await executeSettlementRailBootstrap(sql, plan, { dryRun })
    } catch (error) {
      await sql.unsafe("ROLLBACK").catch(() => undefined)
      throw error
    }
    await sql.unsafe(dryRun ? "ROLLBACK" : "COMMIT")
    console.log(
      JSON.stringify(
        { ...outcome, executor, database: describeDatabaseTarget(databaseUrl), executed_at: new Date().toISOString() },
        null,
        2,
      ),
    )
  } finally {
    await sql.end().catch(() => undefined)
  }
}

main().catch((error) => {
  if (error instanceof SettlementRailBootstrapError) {
    console.error(JSON.stringify({ error: error.reason, message: error.message, details: error.details }))
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
  process.exit(1)
})
