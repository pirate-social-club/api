#!/usr/bin/env bun

import { spawn } from "node:child_process"

import {
  REWARD_SETTLEMENT_PRIVATE_KEY_ENV,
  REWARD_SETTLEMENT_PRIVATE_KEY_SECRET,
  assertRewardSettlementAddress,
  assertRewardSettlementSyncTarget,
  deriveRewardSettlementAddress,
} from "./_lib/reward-settlement-signer-provisioning"

type Mode = "derive-address" | "sync-worker-secret"

function usage(exitCode = 1): never {
  console.error(`Usage:
  bun scripts/provision-reward-settlement-signer.ts derive-address
  bun scripts/provision-reward-settlement-signer.ts sync-worker-secret --expected-address 0x... --environment staging
  bun scripts/provision-reward-settlement-signer.ts sync-worker-secret --expected-address 0x... --environment production --confirm-production

The private key must be injected through ${REWARD_SETTLEMENT_PRIVATE_KEY_ENV}; never pass it as an argument.
sync-worker-secret validates the derived address, then streams the key to Wrangler over stdin.`)
  process.exit(exitCode)
}

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name)
  if (index < 0) return null
  const result = argv[index + 1]?.trim()
  if (!result || result.startsWith("--")) usage()
  return result
}

function privateKey(): string {
  const value = process.env[REWARD_SETTLEMENT_PRIVATE_KEY_ENV]?.trim()
  if (!value) throw new Error(`${REWARD_SETTLEMENT_PRIVATE_KEY_ENV}_is_missing`)
  return value
}

function wranglerEnvironment(): Record<string, string> {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID",
  ]
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] == null ? [] : [[name, process.env[name] as string]]))
}

async function syncWorkerSecret(input: {
  key: string
  expectedAddress: string
  environment: string
  confirmProduction: boolean
}): Promise<void> {
  const environment = assertRewardSettlementSyncTarget({
    environment: input.environment,
    infisicalEnvironment: process.env.ENVIRONMENT,
    confirmProduction: input.confirmProduction,
  })
  const address = assertRewardSettlementAddress({ privateKey: input.key, expectedAddress: input.expectedAddress })
  const child = spawn("bunx", [
    "wrangler", "secret", "put", REWARD_SETTLEMENT_PRIVATE_KEY_SECRET,
    "--env", environment, "--config", "wrangler.jsonc",
  ], {
    cwd: import.meta.dir.replace(/\/scripts$/, ""),
    env: wranglerEnvironment(),
    stdio: ["pipe", "inherit", "inherit"],
  })
  child.stdin.end(input.key)
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
  if (exitCode !== 0) throw new Error(`wrangler_secret_put_failed_${exitCode}`)
  console.log(`reward_settlement_worker_secret_synced environment=${environment} address=${address}`)
}

const argv = process.argv.slice(2)
if (argv.includes("--help") || argv.includes("-h")) usage(0)
const mode = argv[0] as Mode | undefined
const key = privateKey()

if (mode === "derive-address") {
  console.log(`reward_settlement_operator_address=${deriveRewardSettlementAddress(key)}`)
} else if (mode === "sync-worker-secret") {
  const expectedAddress = flagValue(argv, "--expected-address")
  const environment = flagValue(argv, "--environment")
  if (!expectedAddress || !environment) usage()
  await syncWorkerSecret({
    key,
    expectedAddress,
    environment,
    confirmProduction: argv.includes("--confirm-production"),
  })
} else {
  usage()
}
