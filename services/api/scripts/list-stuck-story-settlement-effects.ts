#!/usr/bin/env bun

import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"
import { JsonRpcProvider } from "ethers"
import {
  classifyStuckSettlementEffect,
  isTransactionHash,
  selectSettlementTransactionHash,
  type TransactionEvidence,
} from "./_lib/stuck-settlement-classifier"

const execFileAsync = promisify(execFile)
const STORY_EFFECT_KINDS = [
  "story_royalty_payment",
  "story_parent_royalty_vault_transfer",
  "story_entitlement_mint",
] as const
const FUNDING_EFFECT_KIND = "buyer_funding_receipt" as const
const SCANNED_EFFECT_KINDS = [FUNDING_EFFECT_KIND, ...STORY_EFFECT_KINDS] as const

type Options = {
  concurrency: number
  cwd: string
  env: "production" | "staging"
  limitDbs: number
  limitPerDb: number
  olderThanMinutes: number
  fundingChainId: number
  fundingRpcUrl: string
  storyChainId: number
  storyRpcUrl: string
  signerAddress: string | null
  wranglerConfig: string
}

type EffectRow = {
  purchase_settlement_effect_id: string
  community_id: string
  quote_id: string
  purchase_id: string
  effect_kind: string
  effect_key: string
  settlement_ref: string | null
  provider_receipt_ref: string | null
  submitted_at: string | null
  updated_at: string
  attempt_count: number
}

function firstNonempty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = value?.trim() ?? ""
    if (normalized) return normalized
  }
  return ""
}

function usage(exitCode = 1): never {
  console.error(`Usage:
  bun scripts/list-stuck-story-settlement-effects.ts [options]

Read-only scan of stale submitted buyer-funding and Story settlement effects. This command issues only SELECT and
JSON-RPC read calls. It never updates an effect, signs a transaction, or broadcasts.

Options:
  --env production|staging   Wrangler environment. Default: staging
  --older-than-minutes N     Minimum submitted age. Default: 30
  --funding-rpc-url URL      Funding-chain RPC (or PIRATE_CHECKOUT_RPC_URL / Base RPC env)
  --funding-chain-id N       Expected funding chain ID. Default: PIRATE_CHECKOUT_SOURCE_CHAIN_ID or 84532
  --story-rpc-url URL        Story RPC URL (or STORY_RPC_URL env); omit to skip Story chain reads
  --story-chain-id N         Expected Story chain ID. Default: STORY_CHAIN_ID or 1315
  --rpc-url URL              Legacy alias for --story-rpc-url
  --signer-address ADDRESS   Optional expected settlement signer for nonce summary
  --concurrency N            Parallel D1 scans. Default: 4
  --limit-dbs N              Limit configured databases; 0 means all. Default: 0
  --limit-per-db N           Maximum effects returned per database. Default: 100
  --wrangler-config PATH     Default: ../community-d1-shard/wrangler.jsonc
  --cwd PATH                 Wrangler working directory. Default: config directory`)
  process.exit(exitCode)
}

export function parseArgs(argv: string[]): Options {
  const defaultFundingChainId = Number(process.env.PIRATE_CHECKOUT_SOURCE_CHAIN_ID || 84532)
  const defaultFundingRpc = firstNonempty(
    process.env.PIRATE_CHECKOUT_RPC_URL,
    defaultFundingChainId === 84532 ? process.env.BASE_SEPOLIA_RPC_URL : undefined,
    defaultFundingChainId === 8453 ? process.env.BASE_MAINNET_RPC_URL : undefined,
    defaultFundingChainId === 8453 ? process.env.ETHEREUM_RPC_URL : undefined,
  )
  const options: Options = {
    concurrency: 4,
    cwd: "",
    env: "staging",
    limitDbs: 0,
    limitPerDb: 100,
    olderThanMinutes: 30,
    fundingChainId: defaultFundingChainId,
    fundingRpcUrl: defaultFundingRpc,
    storyChainId: Number(process.env.STORY_CHAIN_ID || 1315),
    storyRpcUrl: process.env.STORY_RPC_URL?.trim() ?? "",
    signerAddress: process.env.STORY_SETTLEMENT_SIGNER_ADDRESS?.trim() || null,
    wranglerConfig: resolve("../community-d1-shard/wrangler.jsonc"),
  }
  for (let index = 0; index < argv.length;) {
    const arg = argv[index]
    const value = argv[index + 1] ?? ""
    switch (arg) {
      case "--concurrency": options.concurrency = Number(value); index += 2; break
      case "--cwd": options.cwd = resolve(value); index += 2; break
      case "--env": options.env = value as Options["env"]; index += 2; break
      case "--funding-chain-id": options.fundingChainId = Number(value); index += 2; break
      case "--funding-rpc-url": options.fundingRpcUrl = value.trim(); index += 2; break
      case "--limit-dbs": options.limitDbs = Number(value); index += 2; break
      case "--limit-per-db": options.limitPerDb = Number(value); index += 2; break
      case "--older-than-minutes": options.olderThanMinutes = Number(value); index += 2; break
      // Commerce ops: remove the #499 spelling after 2026-08-16, once saved
      // invocations have moved to the rail-specific option.
      case "--rpc-url": options.storyRpcUrl = value.trim(); index += 2; break
      case "--signer-address": options.signerAddress = value.trim() || null; index += 2; break
      case "--story-chain-id": options.storyChainId = Number(value); index += 2; break
      case "--story-rpc-url": options.storyRpcUrl = value.trim(); index += 2; break
      case "--wrangler-config": options.wranglerConfig = resolve(value); index += 2; break
      case "-h":
      case "--help": usage(0)
      default: throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!options.cwd) options.cwd = dirname(options.wranglerConfig)
  if (options.env !== "production" && options.env !== "staging") throw new Error("--env must be production or staging")
  for (const [name, value, allowZero] of [
    ["--concurrency", options.concurrency, false],
    ["--funding-chain-id", options.fundingChainId, false],
    ["--limit-dbs", options.limitDbs, true],
    ["--limit-per-db", options.limitPerDb, false],
    ["--older-than-minutes", options.olderThanMinutes, false],
    ["--story-chain-id", options.storyChainId, false],
  ] as const) {
    if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`)
  }
  return options
}

function parseWranglerJson(output: string): any[] {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "")
  const match = clean.match(/(^|\n)\s*(\[\s*\{[\s\S]*\])\s*$/)
  if (!match) throw new Error(`wrangler_json_missing: ${clean.slice(0, 300)}`)
  return JSON.parse(match[2]) as any[]
}

async function discoverDbs(options: Options): Promise<string[]> {
  const config = await readFile(options.wranglerConfig, "utf8")
  const suffix = options.env === "production" ? "prod" : "staging"
  const pattern = new RegExp(`"database_name": "(community-d1-pool-\\d{4}-${suffix})"`, "g")
  const dbs = [...new Set([...config.matchAll(pattern)].map((match) => match[1]))].sort()
  return options.limitDbs ? dbs.slice(0, options.limitDbs) : dbs
}

async function wranglerSelect(options: Options, db: string, sql: string): Promise<any[]> {
  const environmentArgs = options.env === "production" ? ["--env", "production"] : []
  const { stdout, stderr } = await execFileAsync(
    "bunx",
    ["wrangler", "d1", "execute", db, ...environmentArgs, "--remote", "--json", "--command", sql],
    { cwd: options.cwd, maxBuffer: 4 * 1024 * 1024, timeout: 90_000 },
  )
  return parseWranglerJson(`${stderr}\n${stdout}`)
}

export function buildStuckEffectsSelect(input: { cutoff: string; limit: number }): string {
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("limit must be a positive integer")
  const cutoff = input.cutoff.replaceAll("'", "''")
  return `
SELECT purchase_settlement_effect_id, community_id, quote_id, purchase_id, effect_kind,
       effect_key, settlement_ref, provider_receipt_ref, submitted_at, updated_at, attempt_count
FROM purchase_settlement_effects
WHERE status = 'submitted'
  AND effect_kind IN (${SCANNED_EFFECT_KINDS.map((kind) => `'${kind}'`).join(", ")})
  AND COALESCE(submitted_at, updated_at) <= '${cutoff}'
ORDER BY COALESCE(submitted_at, updated_at) ASC
LIMIT ${input.limit}`.trim()
}

export function selectEffectTransactionHash(row: Pick<EffectRow,
  "effect_kind" | "effect_key" | "settlement_ref" | "provider_receipt_ref"
>): string | null {
  if (row.effect_kind === FUNDING_EFFECT_KIND) return row.effect_key.trim() || null
  return selectSettlementTransactionHash({
    settlementRef: row.settlement_ref,
    providerReceiptRef: row.provider_receipt_ref,
  })
}

async function inspectDb(options: Options, db: string, cutoff: string): Promise<{ db: string; rows: EffectRow[]; error?: string }> {
  try {
    const tablePayload = await wranglerSelect(options, db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='purchase_settlement_effects'")
    if (Number(tablePayload?.[0]?.results?.[0]?.n ?? 0) !== 1) return { db, rows: [] }
    const payload = await wranglerSelect(options, db, buildStuckEffectsSelect({ cutoff, limit: options.limitPerDb }))
    return { db, rows: (payload?.[0]?.results ?? []) as EffectRow[] }
  } catch {
    return { db, rows: [], error: "wrangler_read_failed" }
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await operation(items[index])
    }
  }))
  return results
}

async function readEvidence(provider: JsonRpcProvider, hash: string): Promise<TransactionEvidence> {
  const [receipt, transaction] = await Promise.all([
    provider.getTransactionReceipt(hash),
    provider.getTransaction(hash),
  ])
  return {
    hash,
    receipt: receipt ? { status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash } : null,
    transaction: transaction ? { from: transaction.from, nonce: transaction.nonce, blockNumber: transaction.blockNumber } : null,
  }
}

async function assertProviderChain(input: {
  label: "funding" | "story"
  provider: JsonRpcProvider
  expectedChainId: number
}): Promise<void> {
  const network = await input.provider.getNetwork()
  const actualChainId = Number(network.chainId)
  assertExpectedChainId({ label: input.label, expectedChainId: input.expectedChainId, actualChainId })
}

export function assertExpectedChainId(input: {
  label: "funding" | "story"
  expectedChainId: number
  actualChainId: number
}): void {
  if (input.actualChainId !== input.expectedChainId) {
    throw new Error(`${input.label}_rpc_chain_mismatch:expected_${input.expectedChainId}:actual_${input.actualChainId}`)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const cutoff = new Date(Date.now() - options.olderThanMinutes * 60_000).toISOString()
  const fundingProvider = options.fundingRpcUrl ? new JsonRpcProvider(options.fundingRpcUrl) : null
  const storyProvider = options.storyRpcUrl ? new JsonRpcProvider(options.storyRpcUrl) : null
  await Promise.all([
    fundingProvider ? assertProviderChain({ label: "funding", provider: fundingProvider, expectedChainId: options.fundingChainId }) : null,
    storyProvider ? assertProviderChain({ label: "story", provider: storyProvider, expectedChainId: options.storyChainId }) : null,
  ])
  const dbs = await discoverDbs(options)
  if (dbs.length === 0) throw new Error("no_community_databases_discovered")
  const scanned = await mapConcurrent(dbs, options.concurrency, (db) => inspectDb(options, db, cutoff))
  const effects = scanned.flatMap(({ db, rows }) => rows.map((row) => ({ db, row })))
  const reports = []
  for (const { db, row } of effects) {
    const evidenceChain = row.effect_kind === FUNDING_EFFECT_KIND ? "funding" : "story"
    const provider = evidenceChain === "funding" ? fundingProvider : storyProvider
    const transactionHash = selectEffectTransactionHash(row)
    let evidence: TransactionEvidence | undefined
    let evidenceError: "rpc_read_failed" | null = null
    if (provider && transactionHash && isTransactionHash(transactionHash)) {
      try { evidence = await readEvidence(provider, transactionHash) }
      catch { evidenceError = "rpc_read_failed" }
    }
    reports.push({
      db,
      effect_id: row.purchase_settlement_effect_id,
      community_id: row.community_id,
      quote_id: row.quote_id,
      purchase_id: row.purchase_id,
      effect_kind: row.effect_kind,
      evidence_chain: evidenceChain,
      submitted_at: row.submitted_at,
      updated_at: row.updated_at,
      attempt_count: Number(row.attempt_count),
      transaction_hash: transactionHash,
      classification: evidenceError
        ? "chain_evidence_unavailable"
        : transactionHash && isTransactionHash(transactionHash) && !provider
          ? "chain_evidence_not_requested"
          : classifyStuckSettlementEffect({ transactionHash, evidence }),
      evidence: evidence ?? null,
      evidence_error: evidenceError,
    })
  }
  let signerNonce: { latest: number; pending: number } | null = null
  if (storyProvider && options.signerAddress) {
    const [latest, pending] = await Promise.all([
      storyProvider.getTransactionCount(options.signerAddress, "latest"),
      storyProvider.getTransactionCount(options.signerAddress, "pending"),
    ])
    signerNonce = { latest, pending }
  }
  const databaseErrors = scanned.filter((entry) => entry.error).map((entry) => ({ db: entry.db, error: entry.error }))
  console.log(JSON.stringify({
    mode: "read_only",
    environment: options.env,
    expected_chain_ids: { funding: options.fundingChainId, story: options.storyChainId },
    chain_reads_requested: { funding: Boolean(fundingProvider), story: Boolean(storyProvider) },
    cutoff,
    databases_scanned: dbs.length,
    scan_complete: databaseErrors.length === 0,
    database_errors: databaseErrors,
    signer_nonce: signerNonce,
    effects: reports,
  }, null, 2))
  if (databaseErrors.length > 0) process.exitCode = 2
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
