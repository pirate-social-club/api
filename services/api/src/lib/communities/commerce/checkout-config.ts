import { Wallet, getAddress } from "ethers"
import type { Env } from "../../../env"
import { badRequestError } from "../../errors"
import { assertPrivateKeyMatchesExpectedAddress, parseExpectedEvmAddress } from "../../evm-signer"
import { normalizeDirectSignerPrivateKey } from "../../story/story-direct-signer"
import {
  resolveBookingSettlementChainId,
  resolveBookingSettlementOperatorAddress,
  resolveRewardsSettlementChainId,
  resolveRewardsSettlementOperatorAddress,
} from "../bookings/booking-chain-config"

const BASE_MAINNET_CHAIN_ID = 8453
const BASE_SEPOLIA_CHAIN_ID = 84532
const BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(String(raw || "").trim())
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

// Returns the configured source chain, or null when the configuration is not
// usable for real value in this environment. Read paths use this so a bad
// money configuration degrades the advertised funding routes instead of
// failing an unrelated read; anything that actually moves value must use
// resolvePirateCheckoutSourceChainId, which throws.
export function resolveUsablePirateCheckoutSourceChainId(env: Env): number | null {
  const chainId = readPositiveInt(
    env.PIRATE_CHECKOUT_SOURCE_CHAIN_ID,
    BASE_SEPOLIA_CHAIN_ID,
  )

  // Production checkout moves real value. Never allow an injected secret to
  // silently override the checked-in mainnet configuration back to testnet.
  if (String(env.ENVIRONMENT || "").trim().toLowerCase() === "production" && chainId !== BASE_MAINNET_CHAIN_ID) {
    return null
  }

  return chainId
}

export function resolvePirateCheckoutSourceChainId(env: Env): number {
  const chainId = resolveUsablePirateCheckoutSourceChainId(env)
  if (chainId === null) {
    throw badRequestError("production Pirate checkout must use Base mainnet")
  }
  return chainId
}

export function resolvePirateCheckoutSourceChainName(chainId: number): string {
  if (chainId === BASE_MAINNET_CHAIN_ID) return "Base"
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return "Base Sepolia"
  return `EIP-155:${chainId}`
}

export function resolvePirateCheckoutUsdcTokenAddress(env: Env): string {
  const chainId = resolvePirateCheckoutSourceChainId(env)
  const explicit = parseExpectedEvmAddress(env.PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS)
  const canonical = chainId === BASE_MAINNET_CHAIN_ID
    ? getAddress(BASE_MAINNET_USDC)
    : chainId === BASE_SEPOLIA_CHAIN_ID
      ? getAddress(BASE_SEPOLIA_USDC)
      : null

  if (explicit) {
    const address = getAddress(explicit)
    if (canonical && address !== canonical) {
      throw badRequestError("PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS does not match canonical USDC for the source chain")
    }
    return address
  }

  if (canonical) return canonical

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
  const privateKey = normalizeDirectSignerPrivateKey(env.PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY)
  if (explicit) {
    const expected = getAddress(explicit)
    if (privateKey) {
      assertPrivateKeyMatchesExpectedAddress({
        privateKey,
        expectedAddress: expected,
        expectedField: "PIRATE_CHECKOUT_OPERATOR_ADDRESS",
      })
    }
    return expected
  }

  if (privateKey) return getAddress(new Wallet(privateKey).address)

  throw badRequestError("PIRATE_CHECKOUT_OPERATOR_ADDRESS is not configured")
}

export function resolvePirateCheckoutOperatorPrivateKey(env: Env): string {
  const privateKey = normalizeDirectSignerPrivateKey(env.PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY)
  if (!privateKey) throw badRequestError("PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY is required for checkout refunds")
  const operatorAddress = resolvePirateCheckoutOperatorAddress(env)
  assertPrivateKeyMatchesExpectedAddress({
    privateKey,
    expectedAddress: operatorAddress,
    expectedField: "PIRATE_CHECKOUT_OPERATOR_ADDRESS",
  })
  return privateKey
}

function assertCheckoutSignerDomainIsDistinct(env: Env, checkoutAddress: string, checkoutChainId: number): void {
  const domains = [
    {
      configured: Boolean(
        String(env.PIRATE_BOOKING_SETTLEMENT_CHAIN_ID ?? "").trim()
        && (
          String(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS ?? "").trim()
          || String(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY ?? "").trim()
        )
      ),
      chainId: () => resolveBookingSettlementChainId(env),
      address: () => resolveBookingSettlementOperatorAddress(env),
      label: "booking",
    },
    {
      configured: Boolean(
        String(env.PIRATE_REWARDS_SETTLEMENT_CHAIN_ID ?? "").trim()
        && (
          String(env.PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS ?? "").trim()
          || String(env.PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY ?? "").trim()
        )
      ),
      chainId: () => resolveRewardsSettlementChainId(env),
      address: () => resolveRewardsSettlementOperatorAddress(env),
      label: "rewards",
    },
  ]
  for (const domain of domains) {
    if (!domain.configured || domain.chainId() !== checkoutChainId) continue
    if (domain.address() === checkoutAddress) {
      throw badRequestError(`Checkout and ${domain.label} settlement must use distinct operator signers on the same chain`)
    }
  }
}

export function resolvePirateCheckoutCustodyKeyEpoch(env: Env): string {
  const epoch = String(env.PIRATE_CHECKOUT_CUSTODY_KEY_EPOCH ?? "").trim()
  if (!epoch || epoch.length > 100) {
    throw badRequestError("PIRATE_CHECKOUT_CUSTODY_KEY_EPOCH is not configured")
  }
  return epoch
}

/**
 * Dark readiness gate for outbound checkout refunds. Paid-claim admission must
 * call this before the funded-intent path is enabled; ordinary inbound checkout
 * remains unchanged during the spike.
 */
export function assertPirateCheckoutRefundReadiness(env: Env): {
  chainId: number
  custodyAccountId: string
  custodyKeyEpoch: string
  operatorAddress: string
  rpcUrl: string
  tokenAddress: string
} {
  const operatorAddress = resolvePirateCheckoutOperatorAddress(env)
  resolvePirateCheckoutOperatorPrivateKey(env)
  const chainId = resolvePirateCheckoutSourceChainId(env)
  assertCheckoutSignerDomainIsDistinct(env, operatorAddress, chainId)
  return {
    chainId,
    custodyAccountId: `pirate_checkout:${operatorAddress.toLowerCase()}`,
    custodyKeyEpoch: resolvePirateCheckoutCustodyKeyEpoch(env),
    operatorAddress,
    rpcUrl: resolvePirateCheckoutRpcUrl(env),
    tokenAddress: resolvePirateCheckoutUsdcTokenAddress(env),
  }
}

export function resolvePirateCheckoutTxWaitTimeoutMs(env: Env): number {
  return readPositiveInt(env.PIRATE_CHECKOUT_TX_WAIT_TIMEOUT_MS, 120_000)
}

export function buildDefaultPirateCheckoutMoneyPolicy(input: {
  env: Env
  communityId: string
}): {
  id: string
  object: "community_money_policy"
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
} {
  // This default policy is embedded in every serialized community, so it is on
  // read paths that have nothing to do with money. When the checkout
  // configuration is unusable we advertise no funding routes rather than
  // throwing: the read succeeds, and every path that actually moves value
  // still fails closed via resolvePirateCheckoutSourceChainId.
  const sourceChainId = resolveUsablePirateCheckoutSourceChainId(input.env)
  const sourceChainName = sourceChainId === null
    ? null
    : resolvePirateCheckoutSourceChainName(sourceChainId)
  return {
    id: `cmp_${input.communityId}`,
    object: "community_money_policy",
    policy_origin: "default",
    funding_preference: "USDC",
    accepted_funding_assets: sourceChainId === null || sourceChainName === null ? [] : [{
      asset_symbol: "USDC",
      chain_namespace: "eip155",
      chain_id: sourceChainId,
      display_name: `USDC on ${sourceChainName}`,
    }],
    accepted_source_chains: sourceChainId === null || sourceChainName === null ? [] : [{
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
  }
}
