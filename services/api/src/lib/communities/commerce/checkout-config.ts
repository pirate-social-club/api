import { Wallet, getAddress } from "ethers"
import type { Env } from "../../../env"
import { badRequestError } from "../../errors"
import { parseExpectedEvmAddress } from "../../evm-signer"
import { normalizeDirectSignerPrivateKey } from "../../story/story-direct-signer"

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
  const chainId = resolvePirateCheckoutSourceChainId(env)

  // PIRATE_CHECKOUT_RPC_URL is an injected secret with no chain in its name,
  // so after a source-chain cutover it is the piece of config most likely to
  // still point at the old network. A stale RPC does not misdirect funds
  // (ethers pins the provider to the expected chain id) but it does strand
  // every payment in "pending", which is silent. Reject it loudly instead.
  const explicit = String(env.PIRATE_CHECKOUT_RPC_URL || "").trim()
  if (explicit) {
    if (chainId === BASE_MAINNET_CHAIN_ID && /(^|[.\/])sepolia\./i.test(explicit)) {
      throw badRequestError("PIRATE_CHECKOUT_RPC_URL points at a testnet while checkout is on Base mainnet")
    }
    return explicit
  }

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
