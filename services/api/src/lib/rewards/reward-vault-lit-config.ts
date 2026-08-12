import { getAddress } from "ethers"

import type { Env } from "../../env"
import { badRequestError } from "../errors"
import { parseExpectedEvmAddress } from "../evm-signer"

export type RewardsSettlementBackend = "local" | "lit_vault" | "eoa_vault"

export type RewardVaultConfig = {
  vaultAddress: string
  policyVersion: bigint
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

export type RewardVaultLitConfig = RewardVaultConfig & {
  apiUrl: string
  usageApiKey: string
  actionIpfsId: string
  actionPolicyVersion: bigint
  requestTimeoutMs: number
  requestMaxAttempts: number
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
  const value = String(env.PIRATE_REWARDS_SETTLEMENT_BACKEND ?? "").trim()
  if (value === "local" || value === "lit_vault" || value === "eoa_vault") return value
  throw badRequestError("PIRATE_REWARDS_SETTLEMENT_BACKEND is required and must be local, lit_vault, or eoa_vault")
}

export function resolveRewardVaultConfig(env: Env): RewardVaultConfig {
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
    vaultAddress: getAddress(vault),
    policyVersion,
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

export function resolveRewardVaultLitConfig(env: Env): RewardVaultLitConfig {
  const vault = resolveRewardVaultConfig(env)
  const actionPolicyVersion = positiveBigInt(
    env.LIT_REWARDS_ACTION_POLICY_VERSION,
    "LIT_REWARDS_ACTION_POLICY_VERSION",
  )
  if (actionPolicyVersion !== vault.policyVersion) {
    throw badRequestError(
      "LIT_REWARDS_ACTION_POLICY_VERSION must match REWARDS_TREASURY_VAULT_POLICY_VERSION",
    )
  }
  return {
    ...vault,
    apiUrl: String(env.LIT_REWARDS_API_URL ?? "https://api.chipotle.litprotocol.com").trim(),
    usageApiKey: required(env.LIT_REWARDS_USAGE_API_KEY, "LIT_REWARDS_USAGE_API_KEY"),
    actionIpfsId: required(env.LIT_REWARDS_ACTION_IPFS_ID, "LIT_REWARDS_ACTION_IPFS_ID"),
    actionPolicyVersion,
    requestTimeoutMs: positiveInteger(
      env.LIT_REWARDS_REQUEST_TIMEOUT_MS,
      20_000,
      "LIT_REWARDS_REQUEST_TIMEOUT_MS",
    ),
    requestMaxAttempts: positiveInteger(
      env.LIT_REWARDS_REQUEST_MAX_ATTEMPTS,
      1,
      "LIT_REWARDS_REQUEST_MAX_ATTEMPTS",
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
