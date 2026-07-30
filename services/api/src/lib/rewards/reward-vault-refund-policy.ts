import { Contract, JsonRpcProvider } from "ethers"

import type { Env } from "../../env"
import { providerUnavailable } from "../errors"
import { resolveRewardsSettlementRpcUrl } from "../communities/bookings/booking-chain-config"
import {
  resolveRewardsSettlementBackend,
  resolveRewardVaultLitConfig,
} from "./reward-vault-lit-config"

const VAULT_POLICY_ABI = [
  "function policyVersion() view returns (uint64)",
  "function maxRefund() view returns (uint256)",
] as const
const USDC_ATOMS_PER_CENT = 10_000n
const MAX_POLICY_OBSERVATION_AGE_SECONDS = 120
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 30

export type RewardVaultRefundPolicyObservation = {
  policyVersion: bigint
  maxRefundAtomic: bigint
  blockNumber: number
  observedAt: string
}

export type RewardVaultRefundPolicyObserver = (
  env: Env,
  now: string,
) => Promise<RewardVaultRefundPolicyObservation | null>

export const observeRewardVaultRefundPolicy: RewardVaultRefundPolicyObserver = async (
  env,
  now,
) => {
  if (resolveRewardsSettlementBackend(env) === "local") return null

  try {
    const expected = resolveRewardVaultLitConfig(env)
    const provider = new JsonRpcProvider(resolveRewardsSettlementRpcUrl(env))
    const block = await provider.getBlock("latest")
    if (!block) throw new Error("latest block was unavailable")

    const nowSeconds = Math.floor(Date.parse(now) / 1000)
    if (!Number.isFinite(nowSeconds)) throw new Error("observation time was invalid")
    const age = nowSeconds - block.timestamp
    if (
      age > MAX_POLICY_OBSERVATION_AGE_SECONDS
      || age < -MAX_FUTURE_CLOCK_SKEW_SECONDS
    ) {
      throw new Error("vault policy observation was stale")
    }

    const vault = new Contract(expected.vaultAddress, VAULT_POLICY_ABI, provider)
    const [policyVersion, maxRefundAtomic] = await Promise.all([
      vault.policyVersion({ blockTag: block.number }) as Promise<bigint>,
      vault.maxRefund({ blockTag: block.number }) as Promise<bigint>,
    ])
    if (policyVersion !== expected.policyVersion) {
      throw new Error("vault policy version did not match pinned configuration")
    }
    if (
      maxRefundAtomic <= 0n
      || maxRefundAtomic % USDC_ATOMS_PER_CENT !== 0n
    ) {
      throw new Error("vault maxRefund was not positive whole-cent USDC")
    }
    return {
      policyVersion,
      maxRefundAtomic,
      blockNumber: block.number,
      observedAt: new Date(block.timestamp * 1000).toISOString(),
    }
  } catch (error) {
    throw providerUnavailable(
      "Reward vault refund policy is unavailable",
      { reason: error instanceof Error ? error.message : String(error) },
      false,
    )
  }
}

export function assertContributionWithinRefundPolicy(
  amountCents: number,
  observation: RewardVaultRefundPolicyObservation | null,
): void {
  if (!observation) return
  const amountAtomic = BigInt(amountCents) * USDC_ATOMS_PER_CENT
  if (amountAtomic > observation.maxRefundAtomic) {
    throw providerUnavailable(
      "Reward contribution exceeds the current single-refund limit",
      {
        amount_atomic: amountAtomic.toString(),
        max_refund_atomic: observation.maxRefundAtomic.toString(),
        policy_version: observation.policyVersion.toString(),
      },
      false,
    )
  }
}
