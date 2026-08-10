#!/usr/bin/env bun

/**
 * Cost benchmark for a registered Base Sepolia rewards Lit Action.
 *
 * This script never broadcasts a signed transaction. The `benchmark` command
 * requires an explicit registered CID and policy, isolates one warm-up from ten
 * measured successes, and brackets both phases with stable balance readings.
 * Chipotle requires the exact action source to be submitted once per cache
 * lifetime; `prime-cache` isolates that inline setup call from the benchmark.
 *
 * Usage:
 *   infisical run --env=dev --path=/spikes/lit-runtime-validation -- \
 *     bun services/api/scripts/lit-cost-benchmark.ts balance
 *
 *   infisical run --env=dev --path=/spikes/lit-runtime-validation -- \
 *     LIT_COST_ACTION_IPFS_ID=... LIT_COST_POLICY_VERSION=2 \
 *     LIT_COST_CACHE_PRIME_CONFIRMED=true LIT_COST_EVIDENCE_PATH=... \
 *     bun services/api/scripts/lit-cost-benchmark.ts prime-cache
 *
 *   infisical run --env=dev --path=/spikes/lit-runtime-validation -- \
 *     LIT_COST_ACTION_IPFS_ID=... LIT_COST_POLICY_VERSION=2 \
 *     LIT_COST_ACCOUNT_IDLE_CONFIRMED=true LIT_COST_EVIDENCE_PATH=... \
 *     bun services/api/scripts/lit-cost-benchmark.ts benchmark
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { RewardVaultTransactionInput } from "../src/lib/rewards/reward-vault-transaction"
import {
  rewardVaultActionRequest,
  verifySignedRewardVaultTransaction,
} from "../src/lib/rewards/reward-vault-transaction"
import { LitChipotleClient, LitChipotleError } from "../src/lib/rewards/lit-chipotle-client"
import { buildRewardVaultLitAction } from "../src/lib/rewards/reward-vault-lit-action"
import {
  createLitRewardVaultExecutor,
  createProductionLitRewardVaultExecutor,
} from "../src/lib/rewards/lit-reward-vault-executor"

const DEFAULT_BASE_URL = "https://api.chipotle.litprotocol.com"
const DEFAULT_RPC_URL = "https://sepolia.base.org"
const RETIRED_POLICY_1_ACTION_IPFS_ID = "QmR9EqhLEK7jE1wp44wLanmeJwK3Wr3kPtsfD4pjAmogm7"
const VAULT_ADDRESS = "0x01c84e513CC823255A9651885Fb59E363B47d55a"
const SIGNER_ADDRESS = "0x6a1C1a6C780E9F2eb23E564C04B6316864468c46"
const RECIPIENT_ADDRESS = "0x000000000000000000000000000000000000dEaD"
const CHAIN_ID = 84_532
const ACTION_MAX_DEADLINE_SECONDS = 7_200
const REQUEST_DEADLINE_SECONDS = 300
const BALANCE_POLL_INTERVAL_MS = 5_000
const DEFAULT_SETTLEMENT_WAIT_SECONDS = 180
const REQUIRED_STABLE_READS = 2
const MEASURED_EXECUTIONS = 10

type Command = "balance" | "execute" | "probe-402" | "prime-cache" | "benchmark"

type BenchmarkConfig = {
  actionIpfsId: string
  policyVersion: bigint
  evidencePath: string | null
}

type BalanceReading = {
  observed_at: string
  balance_cents_raw: number
  available_credit_cents: number
  balance_display: string
  request_id: string | null
  latency_ms: number
}

type ActionObservation = {
  status: number | null
  request_id: string | null
  latency_ms: number | null
}

function requiredApiKey(): string {
  const value = process.env.LIT_SPIKE_API_KEY?.trim() ?? ""
  if (!value || value.startsWith("REPLACE_ME")) {
    throw new Error("LIT_SPIKE_API_KEY is missing or still a placeholder")
  }
  return value
}

function command(argv: string[]): Command {
  const value = argv[0] ?? "balance"
  if (
    value === "balance"
    || value === "execute"
    || value === "probe-402"
    || value === "prime-cache"
    || value === "benchmark"
  ) {
    return value
  }
  throw new Error("usage: lit-cost-benchmark.ts [balance|execute|probe-402|prime-cache|benchmark]")
}

function benchmarkConfig(selected: Command): BenchmarkConfig | null {
  if (selected === "balance") return null
  const actionIpfsId = process.env.LIT_COST_ACTION_IPFS_ID?.trim() ?? ""
  if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/u.test(actionIpfsId)) {
    throw new Error("LIT_COST_ACTION_IPFS_ID must be an explicit CIDv0 registered with Lit")
  }
  const rawPolicyVersion = process.env.LIT_COST_POLICY_VERSION?.trim() ?? ""
  if (!/^[1-9][0-9]*$/u.test(rawPolicyVersion)) {
    throw new Error("LIT_COST_POLICY_VERSION must be an explicit positive integer")
  }
  if (selected === "benchmark" && process.env.LIT_COST_ACCOUNT_IDLE_CONFIRMED !== "true") {
    throw new Error("benchmark requires LIT_COST_ACCOUNT_IDLE_CONFIRMED=true")
  }
  if (selected === "prime-cache" && process.env.LIT_COST_CACHE_PRIME_CONFIRMED !== "true") {
    throw new Error("prime-cache requires LIT_COST_CACHE_PRIME_CONFIRMED=true")
  }
  if (
    (selected === "benchmark" || selected === "prime-cache")
    && actionIpfsId === RETIRED_POLICY_1_ACTION_IPFS_ID
  ) {
    throw new Error(`${selected} refuses the retired policy-1 action CID`)
  }
  if ((selected === "benchmark" || selected === "prime-cache") && rawPolicyVersion !== "2") {
    throw new Error(`staging ${selected} requires the live vault policy version 2`)
  }
  const evidencePath = process.env.LIT_COST_EVIDENCE_PATH?.trim() || null
  if ((selected === "benchmark" || selected === "prime-cache") && evidencePath === null) {
    throw new Error(`${selected} requires LIT_COST_EVIDENCE_PATH for durable evidence`)
  }
  return { actionIpfsId, policyVersion: BigInt(rawPolicyVersion), evidencePath }
}

function settlementWaitMs(): number {
  const raw = process.env.LIT_COST_SETTLEMENT_WAIT_SECONDS?.trim()
  const value = raw ? Number(raw) : DEFAULT_SETTLEMENT_WAIT_SECONDS
  if (!Number.isSafeInteger(value) || value < 30 || value > 900) {
    throw new Error("LIT_COST_SETTLEMENT_WAIT_SECONDS must be an integer from 30 through 900")
  }
  return value * 1_000
}

function endpoint(baseUrl: string, path: string): string {
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== "https:") throw new Error("Lit API base URL must use HTTPS")
  parsed.pathname = `/core/v1/${path.replace(/^\/+/, "")}`
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString()
}

function apiRoot(baseUrl: string): string {
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== "https:") throw new Error("Lit API base URL must use HTTPS")
  parsed.pathname = parsed.pathname.replace(/\/core\/v1\/?$/u, "") || "/"
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString()
}

function roundedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

async function balance(apiKey: string, baseUrl: string): Promise<BalanceReading> {
  const startedAt = performance.now()
  const response = await fetch(endpoint(baseUrl, "billing/balance"), {
    headers: { "X-Api-Key": apiKey },
    redirect: "manual",
  })
  const decoded = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || !decoded) throw new Error(`Lit balance request failed with HTTP ${response.status}`)
  const balanceCentsRaw = Number(decoded.balance_cents)
  const balanceDisplay = decoded.balance_display
  if (!Number.isSafeInteger(balanceCentsRaw) || balanceCentsRaw > 0 || typeof balanceDisplay !== "string") {
    throw new Error("Lit balance response was invalid")
  }
  return {
    observed_at: new Date().toISOString(),
    balance_cents_raw: balanceCentsRaw,
    available_credit_cents: Math.abs(balanceCentsRaw),
    balance_display: balanceDisplay,
    request_id: response.headers.get("x-request-id"),
    latency_ms: roundedMilliseconds(startedAt),
  }
}

async function signerNonce(rpcUrl: string): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionCount",
      params: [SIGNER_ADDRESS, "latest"],
    }),
  })
  const decoded = await response.json().catch(() => null) as { result?: unknown } | null
  if (!response.ok || typeof decoded?.result !== "string" || !/^0x[0-9a-f]+$/iu.test(decoded.result)) {
    throw new Error("Base Sepolia signer nonce request failed")
  }
  const nonce = Number(BigInt(decoded.result))
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Base Sepolia signer nonce was invalid")
  return nonce
}

async function executeOnce(
  apiKey: string,
  baseUrl: string,
  rpcUrl: string,
  config: BenchmarkConfig,
  effectId: string,
  observation: ActionObservation,
  source: "registered_cid" | "inline_cache_prime" = "registered_cid",
): Promise<{ tx_hash: string }> {
  const fetchImpl: typeof fetch = async (input, init) => {
    const startedAt = performance.now()
    const response = await fetch(input, init)
    observation.status = response.status
    observation.request_id = response.headers.get("x-request-id")
    observation.latency_ms = roundedMilliseconds(startedAt)
    return response
  }
  const client = new LitChipotleClient({
    usageApiKey: apiKey,
    baseUrl: apiRoot(baseUrl),
    maxAttempts: 1,
    timeoutMs: 20_000,
    fetchImpl,
  })
  const execute = source === "registered_cid"
    ? createProductionLitRewardVaultExecutor(client, config.actionIpfsId, {
      policyVersion: config.policyVersion,
      maxDeadlineSeconds: ACTION_MAX_DEADLINE_SECONDS,
    })
    : createLitRewardVaultExecutor(client, { code: buildRewardVaultLitAction({
      vaultAddress: VAULT_ADDRESS,
      signerAddress: SIGNER_ADDRESS,
      chainId: CHAIN_ID,
      policyVersion: config.policyVersion,
      maxDeadlineSeconds: ACTION_MAX_DEADLINE_SECONDS,
      maxFeePerGasWei: 50_000_000_000n,
      maxPriorityFeePerGasWei: 25_000_000_000n,
      maxGasLimit: 300_000n,
    }) })
  const now = Date.now()
  const input: RewardVaultTransactionInput = {
    effectKind: "reward_cashout",
    effectId,
    recipient: RECIPIENT_ADDRESS,
    amount: 1n,
    deadline: BigInt(Math.floor(now / 1_000) + REQUEST_DEADLINE_SECONDS),
    policyVersion: config.policyVersion,
    vaultAddress: VAULT_ADDRESS,
    signerAddress: SIGNER_ADDRESS,
    chainId: CHAIN_ID,
    nonce: await signerNonce(rpcUrl),
    gas: {
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasLimit: 200_000n,
    },
  }
  const request = rewardVaultActionRequest(input)
  const result = await execute(request)
  const verified = verifySignedRewardVaultTransaction(result.signedTx, input)
  return { tx_hash: verified.txHash }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function settledBalances(
  apiKey: string,
  baseUrl: string,
  before: BalanceReading,
  maximumWaitMs: number,
): Promise<BalanceReading[]> {
  const readings: BalanceReading[] = []
  const deadline = Date.now() + maximumWaitMs
  let changed = false
  let stableReads = 0
  let previous = before.available_credit_cents
  while (Date.now() < deadline) {
    await sleep(BALANCE_POLL_INTERVAL_MS)
    const reading = await balance(apiKey, baseUrl)
    readings.push(reading)
    if (reading.available_credit_cents !== before.available_credit_cents) changed = true
    stableReads = reading.available_credit_cents === previous ? stableReads + 1 : 0
    previous = reading.available_credit_cents
    if (changed && stableReads >= REQUIRED_STABLE_READS - 1) break
  }
  return readings
}

async function stableBalances(
  apiKey: string,
  baseUrl: string,
  maximumWaitMs: number,
): Promise<BalanceReading[]> {
  const readings: BalanceReading[] = []
  const deadline = Date.now() + maximumWaitMs
  let stableReads = 0
  let previous: number | null = null
  while (Date.now() < deadline) {
    const reading = await balance(apiKey, baseUrl)
    readings.push(reading)
    stableReads = reading.available_credit_cents === previous ? stableReads + 1 : 1
    previous = reading.available_credit_cents
    if (stableReads >= REQUIRED_STABLE_READS) return readings
    await sleep(BALANCE_POLL_INTERVAL_MS)
  }
  throw new Error("Lit balance did not produce two consecutive stable readings")
}

async function successfulExecution(
  apiKey: string,
  baseUrl: string,
  rpcUrl: string,
  config: BenchmarkConfig,
  effectId: string,
): Promise<{ outcome: "success"; observation: ActionObservation; tx_hash: string }> {
  const observation: ActionObservation = { status: null, request_id: null, latency_ms: null }
  const result = await executeOnce(apiKey, baseUrl, rpcUrl, config, effectId, observation)
  if (observation.status !== 200 || !observation.request_id) {
    throw new Error(`Lit execution ${effectId} lacked an HTTP 200 request-ID observation`)
  }
  return { outcome: "success", observation, ...result }
}

async function writeEvidence(path: string, evidence: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" })
}

async function runBenchmark(
  apiKey: string,
  baseUrl: string,
  rpcUrl: string,
  config: BenchmarkConfig,
): Promise<void> {
  const startedAt = new Date().toISOString()
  const initialReadings = await stableBalances(apiKey, baseUrl, settlementWaitMs())
  const initial = initialReadings.at(-1) as BalanceReading
  if (initial.available_credit_cents === 0) throw new Error("refusing paid benchmark: Lit balance is zero")

  const runId = Date.now()
  const warmup = await successfulExecution(
    apiKey,
    baseUrl,
    rpcUrl,
    config,
    `lit_cost_warmup_${runId}`,
  )
  const warmupBillingReadings = await settledBalances(
    apiKey,
    baseUrl,
    initial,
    settlementWaitMs(),
  )
  const measuredBefore = warmupBillingReadings.at(-1) as BalanceReading
  if (measuredBefore.available_credit_cents === initial.available_credit_cents) {
    throw new Error("warm-up billing did not settle; refusing to contaminate the measured bracket")
  }

  const executions = []
  for (let index = 1; index <= MEASURED_EXECUTIONS; index += 1) {
    executions.push(await successfulExecution(
      apiKey,
      baseUrl,
      rpcUrl,
      config,
      `lit_cost_measured_${runId}_${index}`,
    ))
  }

  const measuredBillingReadings = await settledBalances(
    apiKey,
    baseUrl,
    measuredBefore,
    settlementWaitMs(),
  )
  const measuredAfter = measuredBillingReadings.at(-1) as BalanceReading
  if (measuredAfter.available_credit_cents === measuredBefore.available_credit_cents) {
    throw new Error("measured billing did not settle inside the configured window")
  }
  const observedChargeCents = measuredBefore.available_credit_cents - measuredAfter.available_credit_cents
  if (observedChargeCents < 0) throw new Error("Lit balance increased during the measured bracket")

  const evidence = {
    schema_version: 1,
    protocol: "registered_cid_warmup_plus_10_double_stable_v1",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    account_idle_attested: true,
    action_ipfs_id: config.actionIpfsId,
    registered_cid_path: true,
    provider_cache_precondition: "satisfied_before_benchmark",
    inline_code_used_in_benchmark: false,
    chain_id: CHAIN_ID,
    policy_version: config.policyVersion.toString(),
    vault_address: VAULT_ADDRESS,
    signer_address: SIGNER_ADDRESS,
    transaction_broadcast: false,
    billing_endpoint: "/core/v1/billing/balance",
    initial_stable_readings: initialReadings,
    warmup,
    warmup_billing_readings: warmupBillingReadings,
    measured_executions: executions,
    measured_billing_readings: measuredBillingReadings,
    billing: {
      observed_charge_cents: observedChargeCents,
      measured_successes: executions.length,
      average_charge_cents: observedChargeCents / executions.length,
      below_original_50_cent_floor: observedChargeCents / executions.length < 50,
      at_or_below_documented_1_cent_rate: observedChargeCents / executions.length <= 1,
    },
    reconciliation: {
      request_ids: [warmup, ...executions].map((entry) => entry.observation.request_id),
      required: true,
      status: "pending_vendor_reconciliation",
    },
  }
  await writeEvidence(config.evidencePath as string, evidence)
  console.log(JSON.stringify(evidence, null, 2))
}

async function main(): Promise<void> {
  const selected = command(process.argv.slice(2))
  const apiKey = requiredApiKey()
  const config = benchmarkConfig(selected)
  const baseUrl = process.env.LIT_SPIKE_BASE_URL?.trim() || DEFAULT_BASE_URL
  const rpcUrl = process.env.LIT_COST_RPC_URL?.trim() || DEFAULT_RPC_URL

  if (selected === "benchmark") {
    await runBenchmark(apiKey, baseUrl, rpcUrl, config as BenchmarkConfig)
    return
  }
  const before = await balance(apiKey, baseUrl)

  if (selected === "balance") {
    console.log(JSON.stringify({ command: selected, before }, null, 2))
    return
  }
  if ((selected === "execute" || selected === "prime-cache") && before.available_credit_cents === 0) {
    throw new Error("refusing paid benchmark: Lit balance is zero")
  }
  if (selected === "probe-402" && before.available_credit_cents !== 0) {
    throw new Error("refusing 402 probe: Lit balance is non-zero")
  }

  let action: { outcome: "success"; observation: ActionObservation; tx_hash: string }
    | {
      outcome: "error"
      observation: ActionObservation
      code: string
      http_status: number | null
      lit_error_token: string | null
    }
  const observation: ActionObservation = { status: null, request_id: null, latency_ms: null }
  try {
    const result = await executeOnce(
      apiKey,
      baseUrl,
      rpcUrl,
      config as BenchmarkConfig,
      `lit_cost_single_${Date.now()}`,
      observation,
      selected === "prime-cache" ? "inline_cache_prime" : "registered_cid",
    )
    action = { outcome: "success", observation, ...result }
  } catch (error) {
    if (!(error instanceof LitChipotleError)) throw error
    action = {
      outcome: "error",
      observation: {
        ...observation,
        status: observation.status ?? error.status ?? null,
      },
      code: error.code,
      http_status: error.status ?? null,
      lit_error_token: error.litErrorToken ?? null,
    }
  }

  const afterReadings = action.outcome === "success"
    ? await settledBalances(apiKey, baseUrl, before, settlementWaitMs())
    : [await balance(apiKey, baseUrl)]
  const after = afterReadings.at(-1) as BalanceReading
  const observedChargeCents = Math.abs(after.available_credit_cents - before.available_credit_cents)
  const evidence = {
    schema_version: 1,
    protocol: selected === "prime-cache" ? "inline_cache_prime_double_stable_v1" : "single_execution_v1",
    command: selected,
    action_ipfs_id: config?.actionIpfsId ?? null,
    chain_id: CHAIN_ID,
    policy_version: config?.policyVersion.toString() ?? null,
    transaction_broadcast: false,
    execution_path: selected === "prime-cache" ? "inline_cache_prime" : "registered_cid",
    before,
    action,
    after_readings: afterReadings,
    billing: {
      observed_charge_cents: observedChargeCents,
      settled: action.outcome !== "success"
        || after.available_credit_cents !== before.available_credit_cents,
    },
  }
  if (selected === "prime-cache") {
    await writeEvidence((config as BenchmarkConfig).evidencePath as string, evidence)
  }
  console.log(JSON.stringify(evidence, null, 2))
}

await main()
