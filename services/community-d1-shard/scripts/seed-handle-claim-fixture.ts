/**
 * Reviewed, exact-target repair for the staging handle-claim release fixture.
 *
 * Dry-run by default. `--apply` executes only the checked-in SQL file against
 * cmty-d1-fixture-staging. This is intentionally not a general D1 SQL wrapper.
 */

import { resolve } from "node:path"

const DATABASE_NAME = "cmty-d1-fixture-staging"
const SQL_FILE = resolve(import.meta.dir, "sql/seed-handle-claim-fixture.sql")

export function seedCommand(): string[] {
  return [
    "bunx",
    "wrangler",
    "d1",
    "execute",
    DATABASE_NAME,
    "--remote",
    "--file",
    SQL_FILE,
  ]
}

async function main(): Promise<void> {
  const apply = Bun.argv.slice(2).includes("--apply")
  if (!apply) {
    console.log(`DRY-RUN: ${seedCommand().join(" ")}`)
    console.log("Pass --apply to seed the reserved staging fixture.")
    return
  }

  const command = seedCommand()
  const proc = Bun.spawn(command, { stderr: "inherit", stdout: "inherit" })
  await proc.exited
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1)
}

if (import.meta.main) await main()
