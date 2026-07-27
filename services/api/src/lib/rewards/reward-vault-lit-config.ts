import { getAddress } from "ethers"

import type { Env } from "../../env"
import { badRequestError } from "../errors"
import { parseExpectedEvmAddress } from "../evm-signer"

export type RewardsSettlementBackend = "local" | "lit_vault"

export type RewardVaultLitConfig = {
  apiUrl: string
  usageApiKey: string
  actionIpfsId: string
  vaultAddress: string
  policyVersion: bigint
  requestTimeoutMs: number
  requestMaxAttempts: number
  signingDeadlineSeconds: number
  /**
   * Gas ceilings, mirroring the values pinned into the reviewed action source.
   * Required rather than defaulted: they must equal the action's pinned policy,
   * and a silent default would make the reconciliation-side check weaker than
   * the signing-side one it is meant to corroborate.
   */
  maxFeePerGasWei: bigint
  maxPriorityFeePerGasWei: bigint
  maxGasLimit: bigint
}

function positiveBigInt(raw: string | undefined, field: string): bigint {
  const value = required(raw, field).trim()
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw badRequestError(`${field} must be a canonical positive integer`)
  }
  return BigInt(value)
}

function positiveInteger(raw: string | undefined, fallback: number, field: string): number {
  const value = raw == null || raw.trim() === "" ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw badRequestError(`${field} must be a positive integer`)
  return value
}

function required(raw: string | undefined, field: string): string {
  const value = String(raw ?? "").trim()
  if (!value) throw badRequestError(`${field} is required for lit_vault rewards settlement`)
  return value
}

export function resolveRewardsSettlementBackend(env: Env): RewardsSettlementBackend {
  const value = String(env.PIRATE_REWARDS_SETTLEMENT_BACKEND ?? "local").trim()
  if (value === "local" || value === "lit_vault") return value
  throw badRequestError("PIRATE_REWARDS_SETTLEMENT_BACKEND must be local or lit_vault")
}

export function resolveRewardVaultLitConfig(env: Env): RewardVaultLitConfig {
  const vault = parseExpectedEvmAddress(env.REWARDS_TREASURY_VAULT_ADDRESS)
  if (!vault) throw badRequestError("REWARDS_TREASURY_VAULT_ADDRESS is invalid")
  const policyVersionRaw = required(
    env.REWARDS_TREASURY_VAULT_POLICY_VERSION,
    "REWARDS_TREASURY_VAULT_POLICY_VERSION",
  )
  let policyVersion: bigint
  try {
    policyVersion = BigInt(policyVersionRaw)
  } catch {
    throw badRequestError("REWARDS_TREASURY_VAULT_POLICY_VERSION must be a positive integer")
  }
  if (policyVersion <= 0n || policyVersion.toString() !== policyVersionRaw) {
    throw badRequestError("REWARDS_TREASURY_VAULT_POLICY_VERSION must be a positive integer")
  }
  return {
    apiUrl: String(env.LIT_REWARDS_API_URL ?? "https://api.chipotle.litprotocol.com").trim(),
    usageApiKey: required(env.LIT_REWARDS_USAGE_API_KEY, "LIT_REWARDS_USAGE_API_KEY"),
    actionIpfsId: required(env.LIT_REWARDS_ACTION_IPFS_ID, "LIT_REWARDS_ACTION_IPFS_ID"),
    vaultAddress: getAddress(vault),
    policyVersion,
    requestTimeoutMs: positiveInteger(
      env.LIT_REWARDS_REQUEST_TIMEOUT_MS,
      20_000,
      "LIT_REWARDS_REQUEST_TIMEOUT_MS",
    ),
    requestMaxAttempts: positiveInteger(
      env.LIT_REWARDS_REQUEST_MAX_ATTEMPTS,
      3,
      "LIT_REWARDS_REQUEST_MAX_ATTEMPTS",
    ),
    maxFeePerGasWei: positiveBigInt(
      env.LIT_REWARDS_MAX_FEE_PER_GAS_WEI,
      "LIT_REWARDS_MAX_FEE_PER_GAS_WEI",
    ),
    maxPriorityFeePerGasWei: positiveBigInt(
      env.LIT_REWARDS_MAX_PRIORITY_FEE_PER_GAS_WEI,
      "LIT_REWARDS_MAX_PRIORITY_FEE_PER_GAS_WEI",
    ),
    maxGasLimit: positiveBigInt(env.LIT_REWARDS_MAX_GAS_LIMIT, "LIT_REWARDS_MAX_GAS_LIMIT"),
    signingDeadlineSeconds: positiveInteger(
      env.LIT_REWARDS_SIGNING_DEADLINE_SECONDS,
      300,
      "LIT_REWARDS_SIGNING_DEADLINE_SECONDS",
    ),
  }
}

export function rewardVaultSigningDeadline(nowMs: number, lifetimeSeconds: number): bigint {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw badRequestError("Lit rewards signing time is invalid")
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw badRequestError("Lit rewards signing deadline lifetime is invalid")
  }
  return BigInt(Math.floor(nowMs / 1000) + lifetimeSeconds)
}
