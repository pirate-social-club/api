/**
 * On-chain preflight for the Base Sepolia adversarial rehearsal.
 *
 * A captured manifest asserts what the topology is; this proves it. Every read
 * is taken at ONE confirmed block, so the checks describe a single consistent
 * state rather than a state that drifted mid-verification — a vault that is
 * unpaused when you read the pause flag and re-owned by the time you read the
 * owner would otherwise pass.
 *
 * Accepts only {@link ExecutableRehearsalManifest}: a manifest validated
 * against source-controlled pins and the real clock. The parser's untrusted
 * result cannot reach here without an explicit unsafe cast.
 *
 * A single mismatch fails the whole preflight, before any Lit request is made.
 */

import { keccak256 } from "ethers"

import type { ExecutableRehearsalManifest } from "./manifest"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/** Vault view selectors, derived from the contract's public state variables. */
const SELECTORS = {
  owner: "0x8da5cb5b",
  pendingOwner: "0xe30c3978",
  settlementOperator: "0x1b6984e8",
  payoutsPaused: "0x301cf6e7",
  refundsPaused: "0xd90866d6",
  policyVersion: "0x58355ead",
  epochDuration: "0x4ff0876a",
  maxPayout: "0xe0176de8",
  payoutEpochCap: "0x38b84cef",
  maxRefund: "0x2353464c",
  refundEpochCap: "0xa39b8f24",
  usdc: "0x3e413bee",
} as const

/** `balanceOf(address)` */
const BALANCE_OF_SELECTOR = "0x70a08231"

export class RehearsalPreflightError extends Error {}

function fail(message: string): never {
  throw new RehearsalPreflightError(`rehearsal preflight failed: ${message}`)
}

/**
 * Narrow chain surface. Every method takes an explicit block number so no
 * implementation can silently read `latest` for one field.
 */
export type PreflightChainReader = {
  chainId(): Promise<number>
  latestConfirmedBlock(): Promise<{ number: number; hash: string }>
  getCode(address: string, blockNumber: number): Promise<string>
  call(to: string, data: string, blockNumber: number): Promise<string>
  getBalance(address: string, blockNumber: number): Promise<bigint>
}

export type PreflightCheck = {
  field: string
  expected: string
  observed: string
  matched: boolean
}

export type PreflightEvidence = {
  blockNumber: number
  blockHash: string
  rpcHost: string
  checks: PreflightCheck[]
  passed: boolean
}

export type ExpectedPauseState = {
  payoutsPaused: boolean
  refundsPaused: boolean
}

/**
 * Validates the RPC endpoint before it is used.
 *
 * HTTPS only, host must be on the allow-list, and no redirects may be followed
 * — a redirected RPC is an unpinned RPC, and every guarantee here rests on
 * reading the chain we think we are reading.
 */
export function assertPinnedRpcUrl(rpcUrl: string, allowedHosts: readonly string[]): string {
  let parsed: URL
  try {
    parsed = new URL(rpcUrl)
  } catch {
    fail("RPC URL is not a valid URL")
  }
  if (parsed.protocol !== "https:") fail(`RPC URL must be HTTPS; got ${parsed.protocol}`)
  if (!allowedHosts.includes(parsed.host)) {
    fail(`RPC host ${parsed.host} is not on the pinned allow-list`)
  }
  return parsed.host
}

function decodeAddress(word: string, field: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(word)) fail(`${field} did not return a 32-byte word`)
  return `0x${word.slice(26)}`.toLowerCase()
}

function decodeBigInt(word: string, field: string): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(word)) fail(`${field} did not return a 32-byte word`)
  return BigInt(word)
}

function decodeBool(word: string, field: string): boolean {
  const value = decodeBigInt(word, field)
  if (value !== 0n && value !== 1n) fail(`${field} returned a non-boolean word`)
  return value === 1n
}

/**
 * Proves the live chain matches the reviewed manifest.
 *
 * `expectedPauseState` is per-scenario and deliberately required: the vault
 * deploys fully paused, a normal-path rehearsal needs it unpaused, and the
 * rejection scenarios need a proven paused state. Reading whatever happens to
 * be there and proceeding would let a scenario silently test nothing.
 */
export async function runRehearsalPreflight(input: {
  manifest: ExecutableRehearsalManifest
  reader: PreflightChainReader
  rpcUrl: string
  allowedRpcHosts: readonly string[]
  expectedPauseState: ExpectedPauseState
}): Promise<PreflightEvidence> {
  const rpcHost = assertPinnedRpcUrl(input.rpcUrl, input.allowedRpcHosts)
  const { manifest } = input

  const observedChainId = await input.reader.chainId()
  const checks: PreflightCheck[] = []
  const record = (field: string, expected: string, observed: string) => {
    checks.push({ field, expected, observed, matched: expected === observed })
  }

  record("chainId", String(manifest.vault.chainId), String(observedChainId))

  // One block for every subsequent read: the snapshot the whole preflight
  // describes.
  const block = await input.reader.latestConfirmedBlock()

  const code = await input.reader.getCode(manifest.vault.address, block.number)
  if (!code || code === "0x") fail("vault address has no deployed bytecode at the pinned block")
  record("vault.bytecodeHash", manifest.vault.bytecodeHash, keccak256(code).toLowerCase())

  const readWord = (selector: string, field: string) =>
    input.reader.call(manifest.vault.address, selector, block.number).then((word) => ({ word, field }))

  const [
    owner,
    pendingOwner,
    settlementOperator,
    usdc,
    policyVersion,
    epochDuration,
    maxPayout,
    payoutEpochCap,
    maxRefund,
    refundEpochCap,
    payoutsPaused,
    refundsPaused,
  ] = await Promise.all([
    readWord(SELECTORS.owner, "owner"),
    readWord(SELECTORS.pendingOwner, "pendingOwner"),
    readWord(SELECTORS.settlementOperator, "settlementOperator"),
    readWord(SELECTORS.usdc, "usdc"),
    readWord(SELECTORS.policyVersion, "policyVersion"),
    readWord(SELECTORS.epochDuration, "epochDuration"),
    readWord(SELECTORS.maxPayout, "maxPayout"),
    readWord(SELECTORS.payoutEpochCap, "payoutEpochCap"),
    readWord(SELECTORS.maxRefund, "maxRefund"),
    readWord(SELECTORS.refundEpochCap, "refundEpochCap"),
    readWord(SELECTORS.payoutsPaused, "payoutsPaused"),
    readWord(SELECTORS.refundsPaused, "refundsPaused"),
  ])

  record("vault.owner", manifest.vault.ownerSafeAddress, decodeAddress(owner.word, "owner"))
  // A pending ownership transfer means someone else can take the vault mid-drill.
  record("vault.pendingOwner", ZERO_ADDRESS, decodeAddress(pendingOwner.word, "pendingOwner"))
  record(
    "vault.settlementOperator",
    manifest.balances.settlementOperatorAddress,
    decodeAddress(settlementOperator.word, "settlementOperator"),
  )
  record("vault.usdc", manifest.vault.usdcAddress, decodeAddress(usdc.word, "usdc"))
  record(
    "vault.policyVersion",
    manifest.vault.policyVersion.toString(),
    decodeBigInt(policyVersion.word, "policyVersion").toString(),
  )
  record(
    "vault.epochDuration",
    manifest.vault.epochDurationSeconds.toString(),
    decodeBigInt(epochDuration.word, "epochDuration").toString(),
  )
  record(
    "vault.maxPayout",
    manifest.vault.maxPayoutAtomic.toString(),
    decodeBigInt(maxPayout.word, "maxPayout").toString(),
  )
  record(
    "vault.payoutEpochCap",
    manifest.vault.payoutEpochCapAtomic.toString(),
    decodeBigInt(payoutEpochCap.word, "payoutEpochCap").toString(),
  )
  record(
    "vault.maxRefund",
    manifest.vault.maxRefundAtomic.toString(),
    decodeBigInt(maxRefund.word, "maxRefund").toString(),
  )
  record(
    "vault.refundEpochCap",
    manifest.vault.refundEpochCapAtomic.toString(),
    decodeBigInt(refundEpochCap.word, "refundEpochCap").toString(),
  )
  record(
    "vault.payoutsPaused",
    String(input.expectedPauseState.payoutsPaused),
    String(decodeBool(payoutsPaused.word, "payoutsPaused")),
  )
  record(
    "vault.refundsPaused",
    String(input.expectedPauseState.refundsPaused),
    String(decodeBool(refundsPaused.word, "refundsPaused")),
  )

  // Balances at the same block as everything else.
  const balanceCall = `${BALANCE_OF_SELECTOR}${manifest.vault.address.slice(2).padStart(64, "0")}`
  const [vaultUsdcWord, signerEth] = await Promise.all([
    input.reader.call(manifest.vault.usdcAddress, balanceCall, block.number),
    input.reader.getBalance(manifest.balances.settlementOperatorAddress, block.number),
  ])
  record(
    "balances.vaultUsdcAtomic",
    manifest.balances.vaultUsdcAtomic.toString(),
    decodeBigInt(vaultUsdcWord, "vault USDC balanceOf").toString(),
  )
  record("balances.signerEthWei", manifest.balances.signerEthWei.toString(), signerEth.toString())

  const mismatches = checks.filter((check) => !check.matched)
  const evidence: PreflightEvidence = {
    blockNumber: block.number,
    blockHash: block.hash,
    rpcHost,
    checks,
    passed: mismatches.length === 0,
  }
  if (!evidence.passed) {
    const summary = mismatches
      .map((check) => `${check.field}: expected ${check.expected}, observed ${check.observed}`)
      .join("; ")
    throw new RehearsalPreflightError(
      `rehearsal preflight failed at block ${block.number} (${block.hash}): ${summary}`,
      { cause: evidence },
    )
  }
  return evidence
}
