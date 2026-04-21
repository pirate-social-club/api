import { Wallet, getAddress } from "ethers"
import type { Env } from "../../types"
import { badRequestError } from "../errors"
import { parseExpectedEvmAddress } from "../evm-signer"
import { normalizeDirectSignerPrivateKey } from "../story/story-direct-signer"

const BASE_MAINNET_CHAIN_ID = 8453
const BASE_SEPOLIA_CHAIN_ID = 84532
const BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(String(raw || "").trim())
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function resolvePirateCheckoutSourceChainId(env: Env): number {
  return readPositiveInt(
    env.PIRATE_CHECKOUT_SOURCE_CHAIN_ID,
    BASE_SEPOLIA_CHAIN_ID,
  )
}

export function resolvePirateCheckoutSourceChainName(chainId: number): string {
  if (chainId === BASE_MAINNET_CHAIN_ID) return "Base"
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return "Base Sepolia"
  return `EIP-155:${chainId}`
}

export function resolvePirateCheckoutUsdcTokenAddress(env: Env): string {
  const explicit = parseExpectedEvmAddress(env.PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS)
  if (explicit) return getAddress(explicit)

  const chainId = resolvePirateCheckoutSourceChainId(env)
  if (chainId === BASE_MAINNET_CHAIN_ID) return getAddress(BASE_MAINNET_USDC)
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return getAddress(BASE_SEPOLIA_USDC)

  throw badRequestError("PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS is required for this source chain")
}

export function resolvePirateCheckoutRpcUrl(env: Env): string {
  const explicit = String(env.PIRATE_CHECKOUT_RPC_URL || "").trim()
  if (explicit) return explicit

  const chainId = resolvePirateCheckoutSourceChainId(env)
  if (chainId === BASE_MAINNET_CHAIN_ID) {
    const baseRpc = String(env.BASE_MAINNET_RPC_URL || env.ETHEREUM_RPC_URL || "").trim()
    if (baseRpc) return baseRpc
  }
  if (chainId === BASE_SEPOLIA_CHAIN_ID) {
    const baseSepoliaRpc = String(env.BASE_SEPOLIA_RPC_URL || "").trim()
    if (baseSepoliaRpc) return baseSepoliaRpc
  }

  throw badRequestError("PIRATE_CHECKOUT_RPC_URL is not configured")
}

export function resolvePirateCheckoutOperatorAddress(env: Env): string {
  const explicit = parseExpectedEvmAddress(env.PIRATE_CHECKOUT_OPERATOR_ADDRESS)
  if (explicit) return getAddress(explicit)

  const privateKey = normalizeDirectSignerPrivateKey(env.PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY)
  if (privateKey) return getAddress(new Wallet(privateKey).address)

  throw badRequestError("PIRATE_CHECKOUT_OPERATOR_ADDRESS is not configured")
}

export function resolvePirateCheckoutTxWaitTimeoutMs(env: Env): number {
  return readPositiveInt(env.PIRATE_CHECKOUT_TX_WAIT_TIMEOUT_MS, 120_000)
}

export function buildDefaultPirateCheckoutMoneyPolicy(input: {
  env: Env
  communityId: string
}): {
  community_id: string
  policy_origin: "default"
  funding_preference: "USDC"
  accepted_funding_assets: Array<{
    asset_symbol: "USDC"
    chain_namespace: "eip155"
    chain_id: number
    display_name: string
  }>
  accepted_source_chains: Array<{
    chain_namespace: "eip155"
    chain_id: number
    display_name: string
  }>
  approved_route_providers: ["pirate_checkout"]
  destination_settlement_chain: {
    chain_namespace: "eip155"
    chain_id: 1315
    display_name: "Story Aeneid"
  }
  destination_settlement_token: "WIP"
  treasury_denomination: "WIP"
  max_slippage_bps: 150
  quote_ttl_seconds: 900
  route_required: true
  route_status_policy: "fail"
  route_hop_tolerance: 3
  updated_at: string
} {
  const sourceChainId = resolvePirateCheckoutSourceChainId(input.env)
  const sourceChainName = resolvePirateCheckoutSourceChainName(sourceChainId)
  return {
    community_id: input.communityId,
    policy_origin: "default",
    funding_preference: "USDC",
    accepted_funding_assets: [{
      asset_symbol: "USDC",
      chain_namespace: "eip155",
      chain_id: sourceChainId,
      display_name: `USDC on ${sourceChainName}`,
    }],
    accepted_source_chains: [{
      chain_namespace: "eip155",
      chain_id: sourceChainId,
      display_name: sourceChainName,
    }],
    approved_route_providers: ["pirate_checkout"],
    destination_settlement_chain: {
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "Story Aeneid",
    },
    destination_settlement_token: "WIP",
    treasury_denomination: "WIP",
    max_slippage_bps: 150,
    quote_ttl_seconds: 900,
    route_required: true,
    route_status_policy: "fail",
    route_hop_tolerance: 3,
    updated_at: new Date(0).toISOString(),
  }
}
