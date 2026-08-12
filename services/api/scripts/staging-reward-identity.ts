#!/usr/bin/env bun

import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Env } from "../src/env"
import { isPostgresControlPlaneUrl, withStandaloneControlPlaneClient } from "../src/lib/runtime-deps"
import {
  cleanupStagingRewardNationalityShadowIdentity,
  cleanupStagingRewardIdentity,
  seedStagingRewardNationalityShadowIdentity,
  seedStagingRewardIdentity,
  type StagingRewardNationalityShadowSnapshot,
  type StagingRewardIdentitySnapshot,
} from "./_lib/staging-reward-identity"

type Mode = "seed" | "seed-nationality-shadow" | "cleanup"

type Options = {
  mode: Mode
  userId: string | null
  nationality: string | null
  provider: "self" | "zkpassport"
  projectEligibility: boolean
  snapshotPath: string
  databaseUrlEnv: string
}

function usage(exitCode = 1): never {
  console.error(`Usage:
  bun scripts/staging-reward-identity.ts seed --user-id usr_... --snapshot /secure/path/reward-identity.json
  bun scripts/staging-reward-identity.ts seed-nationality-shadow --user-id usr_... [--provider self|zkpassport] [--project-eligibility] [--nationality USA] --snapshot /secure/path/reward-identity.json
  bun scripts/staging-reward-identity.ts cleanup --snapshot /secure/path/reward-identity.json [--user-id usr_...]

Requires ENVIRONMENT=staging and a Postgres URL in CONTROL_PLANE_MIGRATOR_DATABASE_URL.
seed accepts only a dedicated unverified user with an active EVM wallet and no active nullifier.
seed-nationality-shadow accepts an existing staging user with no active Self nullifier or
reward-document binding; it leaves the user's reward eligibility unchanged and creates one
reversible Self nullifier, optional bound nationality attestation, and active selection.
The mode never creates a provider API or changes the production self|very allowlist.`)
  process.exit(exitCode)
}

function value(argv: string[], index: number, flag: string): string {
  const result = argv[index + 1]?.trim()
  if (!result) {
    console.error(`${flag} requires a value`)
    usage()
  }
  return result
}

function parseArgs(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) usage(0)
  const mode = argv[0] as Mode | undefined
  if (mode !== "seed" && mode !== "seed-nationality-shadow" && mode !== "cleanup") usage()
  let userId: string | null = null
  let nationality: string | null = null
  let provider: "self" | "zkpassport" = "self"
  let projectEligibility = false
  let snapshotPath = ""
  let databaseUrlEnv = "CONTROL_PLANE_MIGRATOR_DATABASE_URL"
  for (let index = 1; index < argv.length;) {
    const flag = argv[index]
    if (flag === "--user-id") {
      userId = value(argv, index, flag)
      index += 2
    } else if (flag === "--nationality") {
      nationality = value(argv, index, flag).toUpperCase()
      index += 2
    } else if (flag === "--provider") {
      const requested = value(argv, index, flag).toLowerCase()
      if (requested !== "self" && requested !== "zkpassport") usage()
      provider = requested
      index += 2
    } else if (flag === "--project-eligibility") {
      projectEligibility = true
      index += 1
    } else if (flag === "--snapshot") {
      snapshotPath = resolve(value(argv, index, flag))
      index += 2
    } else if (flag === "--database-url-env") {
      databaseUrlEnv = value(argv, index, flag)
      index += 2
    } else {
      console.error(`unknown argument: ${flag}`)
      usage()
    }
  }
  if (!snapshotPath || (mode !== "cleanup" && !userId)) usage()
  if (nationality && !/^[A-Z]{3}$/u.test(nationality)) {
    throw new Error("nationality_must_be_iso_3166_alpha_3")
  }
  if (mode !== "seed-nationality-shadow" && (nationality || provider !== "self" || projectEligibility)) usage()
  return { mode, userId, nationality, provider, projectEligibility, snapshotPath, databaseUrlEnv }
}

function assertStagingEnvironment(options: Options): Env {
  if (String(process.env.ENVIRONMENT ?? "").trim().toLowerCase() !== "staging") {
    throw new Error("refusing_to_seed_reward_identity_outside_staging")
  }
  if (String(process.env.STAGING_TEST_AUTH_ENABLED ?? "").trim().toLowerCase() !== "true") {
    throw new Error("staging_test_auth_must_be_enabled")
  }
  const databaseUrl = String(process.env[options.databaseUrlEnv] ?? "").trim()
  if (!isPostgresControlPlaneUrl(databaseUrl)) throw new Error(`${options.databaseUrlEnv}_must_be_postgres`)
  return { ...process.env, CONTROL_PLANE_DATABASE_URL: databaseUrl } as unknown as Env
}

function readSnapshot(path: string): StagingRewardIdentitySnapshot | StagingRewardNationalityShadowSnapshot {
  return JSON.parse(readFileSync(path, "utf8")) as StagingRewardIdentitySnapshot | StagingRewardNationalityShadowSnapshot
}

const options = parseArgs(process.argv.slice(2))
const env = assertStagingEnvironment(options)
await withStandaloneControlPlaneClient(env, async (client) => {
  if (options.mode === "seed") {
    const snapshot = await seedStagingRewardIdentity({
      client,
      userId: options.userId as string,
      rowLocks: true,
      writeSnapshot: (value) => {
        writeFileSync(options.snapshotPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 })
        chmodSync(options.snapshotPath, 0o600)
      },
    })
    console.log(`staging_reward_identity_seeded user_id=${snapshot.user_id}`)
    console.log(`snapshot=${options.snapshotPath}`)
    return
  }

  if (options.mode === "seed-nationality-shadow") {
    const snapshot = await seedStagingRewardNationalityShadowIdentity({
      client,
      userId: options.userId as string,
      provider: options.provider,
      projectEligibility: options.projectEligibility,
      nationality: options.nationality,
      rowLocks: true,
      writeSnapshot: (value) => {
        writeFileSync(options.snapshotPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 })
        chmodSync(options.snapshotPath, 0o600)
      },
    })
    console.log(`staging_reward_nationality_shadow_identity_seeded user_id=${snapshot.user_id}`)
    console.log(`nationality_evidence=${snapshot.seed.nationality ? "bound" : "missing"}`)
    console.log(`snapshot=${options.snapshotPath}`)
    return
  }

  const snapshot = readSnapshot(options.snapshotPath)
  if (options.userId && options.userId !== snapshot.user_id) {
    throw new Error("snapshot_user_id_mismatch")
  }
  const result = snapshot.purpose === "staging_reward_nationality_shadow"
    ? await cleanupStagingRewardNationalityShadowIdentity({ client, snapshot, rowLocks: true })
    : await cleanupStagingRewardIdentity({ client, snapshot, rowLocks: true })
  console.log(`staging_reward_identity_cleanup=${result} user_id=${snapshot.user_id}`)
  console.log(`snapshot_retained=${options.snapshotPath}`)
})
