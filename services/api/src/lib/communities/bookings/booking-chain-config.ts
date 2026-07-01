import { Wallet, getAddress } from "ethers"

import type { Env } from "../../../env"
import { badRequestError } from "../../errors"
import { assertPrivateKeyMatchesExpectedAddress, parseExpectedEvmAddress } from "../../evm-signer"
import { normalizeDirectSignerPrivateKey } from "../../story/story-direct-signer"
import { resolvePirateCheckoutSourceChainName } from "../commerce/checkout-config"

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

function readRequiredPositiveInt(raw: string | undefined, name: string): number {
  const parsed = Number(String(raw || "").trim())
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequestError(`${name} is required for booking settlement`)
  }
  return parsed
}

export function resolveBookingSettlementChainId(env: Env): number {
  const chainId = readRequiredPositiveInt(env.PIRATE_BOOKING_SETTLEMENT_CHAIN_ID, "PIRATE_BOOKING_SETTLEMENT_CHAIN_ID")
  if (!ALLOWED_CHAIN_IDS.has(chainId)) {
    throw badRequestError(`PIRATE_BOOKING_SETTLEMENT_CHAIN_ID ${chainId} is not an allowlisted booking settlement chain`)
  }
  return chainId
}

export function resolveBookingSettlementChainName(chainId: number): string {
  return resolvePirateCheckoutSourceChainName(chainId)
}

export function resolveBookingSettlementUsdcTokenAddress(env: Env): string {
  const chainId = resolveBookingSettlementChainId(env)
  const canonical = CANONICAL_USDC_BY_CHAIN.get(chainId) ?? null

  const explicit = parseExpectedEvmAddress(env.PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS)
  if (explicit) {
    const override = getAddress(explicit)
    const overrideAllowed = String(env.PIRATE_BOOKING_SETTLEMENT_ALLOW_TOKEN_OVERRIDE || "").trim().toLowerCase() === "true"
    if (canonical && override !== canonical && !overrideAllowed) {
      throw badRequestError("PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS does not match the canonical USDC for this chain")
    }
    return override
  }

  if (canonical) return canonical

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
  const privateKey = normalizeDirectSignerPrivateKey(String(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY || "").trim())

  if (explicit) {
    const expected = getAddress(explicit)
    // The operator address names the nonce-serializing coordinator DO; the private key is what actually
    // signs. If both are configured they MUST agree — otherwise the DO nonce domain would be split from
    // the signing wallet (two DOs, one wallet → nonce collisions). Fail closed on any mismatch.
    if (privateKey) {
      assertPrivateKeyMatchesExpectedAddress({
        privateKey,
        expectedAddress: expected,
        expectedField: "PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS",
      })
    }
    return expected
  }

  if (privateKey) return getAddress(new Wallet(privateKey).address)

  throw badRequestError("PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS is required for booking settlement")
}
