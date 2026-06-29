import { Wallet, getAddress } from "ethers"

import type { Env } from "../../../env"
import { badRequestError } from "../../errors"
import { parseExpectedEvmAddress } from "../../evm-signer"
import { normalizeDirectSignerPrivateKey } from "../../story/story-direct-signer"
import { resolvePirateCheckoutSourceChainName } from "../commerce/checkout-config"

const BASE_MAINNET_CHAIN_ID = 8453
const BASE_SEPOLIA_CHAIN_ID = 84532
const BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"

function readRequiredPositiveInt(raw: string | undefined, name: string): number {
  const parsed = Number(String(raw || "").trim())
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequestError(`${name} is required for booking settlement`)
  }
  return parsed
}

export function resolveBookingSettlementChainId(env: Env): number {
  return readRequiredPositiveInt(env.PIRATE_BOOKING_SETTLEMENT_CHAIN_ID, "PIRATE_BOOKING_SETTLEMENT_CHAIN_ID")
}

export function resolveBookingSettlementChainName(chainId: number): string {
  return resolvePirateCheckoutSourceChainName(chainId)
}

export function resolveBookingSettlementUsdcTokenAddress(env: Env): string {
  const explicit = parseExpectedEvmAddress(env.PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS)
  if (explicit) return getAddress(explicit)

  const chainId = resolveBookingSettlementChainId(env)
  if (chainId === BASE_MAINNET_CHAIN_ID) return getAddress(BASE_MAINNET_USDC)
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return getAddress(BASE_SEPOLIA_USDC)

  throw badRequestError("PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS is required for booking settlement")
}

export function resolveBookingSettlementRpcUrl(env: Env): string {
  const explicit = String(env.PIRATE_BOOKING_SETTLEMENT_RPC_URL || "").trim()
  if (explicit) return explicit

  const chainId = resolveBookingSettlementChainId(env)
  if (chainId === BASE_MAINNET_CHAIN_ID) {
    const baseMainnetRpc = String(env.BASE_MAINNET_RPC_URL || "").trim()
    if (baseMainnetRpc) return baseMainnetRpc
  }
  if (chainId === BASE_SEPOLIA_CHAIN_ID) {
    const baseSepoliaRpc = String(env.BASE_SEPOLIA_RPC_URL || "").trim()
    if (baseSepoliaRpc) return baseSepoliaRpc
  }

  throw badRequestError("PIRATE_BOOKING_SETTLEMENT_RPC_URL is required for booking settlement")
}

export function resolveBookingSettlementOperatorPrivateKey(env: Env): string {
  const privateKey = normalizeDirectSignerPrivateKey(String(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY || "").trim())
  if (!privateKey) throw badRequestError("PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY is invalid")
  return privateKey
}

export function resolveBookingSettlementOperatorAddress(env: Env): string {
  const explicit = parseExpectedEvmAddress(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS)
  if (explicit) return getAddress(explicit)

  const privateKey = normalizeDirectSignerPrivateKey(String(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY || "").trim())
  if (privateKey) return getAddress(new Wallet(privateKey).address)

  throw badRequestError("PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS is required for booking settlement")
}
