import { Wallet, getAddress } from "ethers"

import type { Env } from "../../../env"
import { badRequestError } from "../../errors"
import { assertPrivateKeyMatchesExpectedAddress, parseExpectedEvmAddress } from "../../evm-signer"
import { normalizeDirectSignerPrivateKey } from "../../story/story-direct-signer"

const BASE_MAINNET_CHAIN_ID = 8453
const BASE_SEPOLIA_CHAIN_ID = 84532
const BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"

// Keep this list in lockstep with the global config (src/lib/bookings/booking-settlement-config.ts):
// only vetted chains may settle real value; a stray/typo chain id must fail closed.
const ALLOWED_CHAIN_IDS: ReadonlySet<number> = new Set([BASE_SEPOLIA_CHAIN_ID, BASE_MAINNET_CHAIN_ID])
const CANONICAL_USDC_BY_CHAIN: ReadonlyMap<number, string> = new Map([
  [BASE_MAINNET_CHAIN_ID, getAddress(BASE_MAINNET_USDC)],
  [BASE_SEPOLIA_CHAIN_ID, getAddress(BASE_SEPOLIA_USDC)],
])

type SettlementOperatorKind = "booking" | "rewards"

function readRequiredPositiveInt(raw: string | undefined, name: string, label: string): number {
  const parsed = Number(String(raw || "").trim())
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequestError(`${name} is required for ${label} settlement`)
  }
  return parsed
}

function envNames(kind: SettlementOperatorKind): {
  label: string
  chainId: keyof Env
  rpcUrl: keyof Env
  usdcToken: keyof Env
  allowTokenOverride: keyof Env
  operatorPrivateKey: keyof Env
  operatorAddress: keyof Env
} {
  if (kind === "rewards") {
    return {
      label: "rewards",
      chainId: "PIRATE_REWARDS_SETTLEMENT_CHAIN_ID",
      rpcUrl: "PIRATE_REWARDS_SETTLEMENT_RPC_URL",
      usdcToken: "PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS",
      allowTokenOverride: "PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE",
      operatorPrivateKey: "PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY",
      operatorAddress: "PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS",
    }
  }
  return {
    label: "booking",
    chainId: "PIRATE_BOOKING_SETTLEMENT_CHAIN_ID",
    rpcUrl: "PIRATE_BOOKING_SETTLEMENT_RPC_URL",
    usdcToken: "PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS",
    allowTokenOverride: "PIRATE_BOOKING_SETTLEMENT_ALLOW_TOKEN_OVERRIDE",
    operatorPrivateKey: "PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY",
    operatorAddress: "PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS",
  }
}

function resolveSettlementChainId(env: Env, kind: SettlementOperatorKind): number {
  const names = envNames(kind)
  const chainId = readRequiredPositiveInt(env[names.chainId] as string | undefined, names.chainId, names.label)
  if (!ALLOWED_CHAIN_IDS.has(chainId)) {
    throw badRequestError(`${names.chainId} ${chainId} is not an allowlisted ${names.label} settlement chain`)
  }
  return chainId
}

export function resolveBookingSettlementChainId(env: Env): number {
  return resolveSettlementChainId(env, "booking")
}

export function resolveRewardsSettlementChainId(env: Env): number {
  return resolveSettlementChainId(env, "rewards")
}

export function assertRewardsCampaignAndSettlementChainsMatch(env: Env): void {
  const campaignChainRaw = String(env.REWARDS_CAMPAIGN_CHAIN_ID ?? "").trim()
  if (!campaignChainRaw) return

  const campaignChainId = Number(campaignChainRaw)
  if (!Number.isSafeInteger(campaignChainId) || campaignChainId < 1) {
    throw badRequestError("REWARDS_CAMPAIGN_CHAIN_ID must be a positive integer")
  }
  if (campaignChainId !== resolveRewardsSettlementChainId(env)) {
    throw badRequestError("Reward campaign and settlement chain IDs must match")
  }
}

function resolveSettlementUsdcTokenAddress(env: Env, kind: SettlementOperatorKind): string {
  const names = envNames(kind)
  const chainId = resolveSettlementChainId(env, kind)
  const canonical = CANONICAL_USDC_BY_CHAIN.get(chainId) ?? null

  const explicit = parseExpectedEvmAddress(env[names.usdcToken] as string | undefined)
  if (explicit) {
    const override = getAddress(explicit)
    const overrideAllowed = String(env[names.allowTokenOverride] || "").trim().toLowerCase() === "true"
    if (canonical && override !== canonical && !overrideAllowed) {
      throw badRequestError(`${names.usdcToken} does not match the canonical USDC for this chain`)
    }
    return override
  }

  if (canonical) return canonical

  throw badRequestError(`${names.usdcToken} is required for ${names.label} settlement`)
}

export function resolveBookingSettlementUsdcTokenAddress(env: Env): string {
  return resolveSettlementUsdcTokenAddress(env, "booking")
}

export function resolveRewardsSettlementUsdcTokenAddress(env: Env): string {
  return resolveSettlementUsdcTokenAddress(env, "rewards")
}

function resolveSettlementRpcUrl(env: Env, kind: SettlementOperatorKind): string {
  const names = envNames(kind)
  const explicit = String(env[names.rpcUrl] || "").trim()
  if (explicit) return explicit

  const chainId = resolveSettlementChainId(env, kind)
  if (chainId === BASE_MAINNET_CHAIN_ID) {
    const baseMainnetRpc = String(env.BASE_MAINNET_RPC_URL || "").trim()
    if (baseMainnetRpc) return baseMainnetRpc
  }
  if (chainId === BASE_SEPOLIA_CHAIN_ID) {
    const baseSepoliaRpc = String(env.BASE_SEPOLIA_RPC_URL || "").trim()
    if (baseSepoliaRpc) return baseSepoliaRpc
  }

  throw badRequestError(`${names.rpcUrl} is required for ${names.label} settlement`)
}

export function resolveBookingSettlementRpcUrl(env: Env): string {
  return resolveSettlementRpcUrl(env, "booking")
}

export function resolveRewardsSettlementRpcUrl(env: Env): string {
  return resolveSettlementRpcUrl(env, "rewards")
}

function resolveSettlementOperatorPrivateKey(env: Env, kind: SettlementOperatorKind): string {
  const names = envNames(kind)
  const privateKey = normalizeDirectSignerPrivateKey(String(env[names.operatorPrivateKey] || "").trim())
  if (!privateKey) throw badRequestError(`${names.operatorPrivateKey} is invalid`)
  return privateKey
}

export function resolveBookingSettlementOperatorPrivateKey(env: Env): string {
  return resolveSettlementOperatorPrivateKey(env, "booking")
}

export function resolveRewardsSettlementOperatorPrivateKey(env: Env): string {
  return resolveSettlementOperatorPrivateKey(env, "rewards")
}

function resolveSettlementOperatorAddress(env: Env, kind: SettlementOperatorKind): string {
  const names = envNames(kind)
  const explicit = parseExpectedEvmAddress(env[names.operatorAddress] as string | undefined)
  const privateKey = normalizeDirectSignerPrivateKey(String(env[names.operatorPrivateKey] || "").trim())

  if (explicit) {
    const expected = getAddress(explicit)
    // The operator address names the nonce-serializing coordinator DO; the private key is what actually
    // signs. If both are configured they MUST agree — otherwise the DO nonce domain would be split from
    // the signing wallet (two DOs, one wallet → nonce collisions). Fail closed on any mismatch.
    if (privateKey) {
      assertPrivateKeyMatchesExpectedAddress({
        privateKey,
        expectedAddress: expected,
        expectedField: names.operatorAddress,
      })
    }
    return expected
  }

  if (privateKey) return getAddress(new Wallet(privateKey).address)

  throw badRequestError(`${names.operatorAddress} is required for ${names.label} settlement`)
}

export function resolveBookingSettlementOperatorAddress(env: Env): string {
  return resolveSettlementOperatorAddress(env, "booking")
}

export function resolveRewardsSettlementOperatorAddress(env: Env): string {
  return resolveSettlementOperatorAddress(env, "rewards")
}

export function assertDistinctBookingAndRewardsSignerDomains(env: Env): void {
  const hasBookingSigner = Boolean(
    String(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS ?? "").trim()
    || String(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY ?? "").trim(),
  )
  const hasBookingChain = Boolean(String(env.PIRATE_BOOKING_SETTLEMENT_CHAIN_ID ?? "").trim())
  if (!hasBookingSigner || !hasBookingChain) return

  const rewardsChainId = resolveRewardsSettlementChainId(env)
  if (resolveBookingSettlementChainId(env) !== rewardsChainId) return
  const rewardsAddress = resolveRewardsSettlementOperatorAddress(env)
  if (resolveBookingSettlementOperatorAddress(env) === rewardsAddress) {
    throw badRequestError("Booking and rewards settlement must use distinct operator signers on the same chain")
  }
}
