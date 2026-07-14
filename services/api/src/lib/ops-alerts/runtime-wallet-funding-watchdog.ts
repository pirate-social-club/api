import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits, getAddress } from "ethers"
import type { Env } from "../../env"
import {
  resolveBookingSettlementChainId,
  resolveBookingSettlementOperatorAddress,
  resolveBookingSettlementRpcUrl,
  resolveBookingSettlementUsdcTokenAddress,
  resolveRewardsSettlementChainId,
  resolveRewardsSettlementOperatorAddress,
  resolveRewardsSettlementRpcUrl,
  resolveRewardsSettlementUsdcTokenAddress,
} from "../communities/bookings/booking-chain-config"
import {
  resolvePirateCheckoutOperatorAddress,
  resolvePirateCheckoutRpcUrl,
  resolvePirateCheckoutSourceChainId,
  resolvePirateCheckoutUsdcTokenAddress,
} from "../communities/commerce/checkout-config"
import { normalizeDirectSignerPrivateKey } from "../story/story-direct-signer"
import {
  resolveStoryChainId,
  resolveStoryRpcUrl,
  resolveStoryRuntimeSignerTargetBalanceWei,
} from "../story/story-runtime-config"
import { captureScheduledWarning } from "./scheduled"

const TASK = "runtime_wallet_funding_watchdog"
const DEFAULT_INTERVAL_MS = 300_000
const DEFAULT_BASE_NATIVE_MIN_WEI = 1_000_000_000_000_000n
const DEFAULT_BASE_USDC_MIN_ATOMIC = 1_000_000n
const ERC20_BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"] as const

export type RuntimeWalletFundingSpec = {
  name: string
  address: `0x${string}`
  chainId: number
  rpcUrl: string
  nativeSymbol: "ETH" | "IP"
  nativeMinWei: bigint
  token?: {
    address: `0x${string}`
    symbol: "USDC"
    decimals: 6
    minAtomic: bigint
  }
}

export type RuntimeWalletFundingAlert = {
  wallet: string
  address: `0x${string}`
  asset: "native" | "USDC"
  balance: bigint
  floor: bigint
}

let lastCheckAtMs: number | null = null

export function resetRuntimeWalletFundingWatchdogStateForTests(): void {
  lastCheckAtMs = null
}

function positiveBigInt(raw: string | undefined, fallback: bigint): bigint {
  const value = String(raw ?? "").trim()
  return /^\d+$/.test(value) && BigInt(value) > 0n ? BigInt(value) : fallback
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(String(raw ?? "").trim(), 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function explorerAddressUrl(chainId: number, address: string): string | null {
  if (chainId === 1315) return `https://aeneid.storyscan.io/address/${address}`
  if (chainId === 84532) return `https://sepolia.basescan.org/address/${address}`
  if (chainId === 8453) return `https://basescan.org/address/${address}`
  return null
}

function hasAny(env: Env, names: Array<keyof Env>): boolean {
  return names.some((name) => Boolean(String(env[name] ?? "").trim()))
}

function storyFunderSpec(env: Env): RuntimeWalletFundingSpec | null {
  const privateKey = normalizeDirectSignerPrivateKey(env.STORY_RUNTIME_FUNDER_PRIVATE_KEY)
    ?? normalizeDirectSignerPrivateKey(env.STORY_CONTRACT_OWNER_PRIVATE_KEY)
  if (!privateKey) return null
  return {
    name: "story-runtime-funder",
    address: getAddress(new Wallet(privateKey).address) as `0x${string}`,
    chainId: resolveStoryChainId(env),
    rpcUrl: resolveStoryRpcUrl(env),
    nativeSymbol: "IP",
    nativeMinWei: positiveBigInt(
      env.STORY_RUNTIME_FUNDER_MIN_BALANCE_WEI,
      resolveStoryRuntimeSignerTargetBalanceWei(env),
    ),
  }
}

function baseSpec(params: {
  name: string
  address: string
  chainId: number
  rpcUrl: string
  usdcAddress: string
  nativeMinWei: bigint
  usdcMinAtomic: bigint
}): RuntimeWalletFundingSpec {
  return {
    name: params.name,
    address: getAddress(params.address) as `0x${string}`,
    chainId: params.chainId,
    rpcUrl: params.rpcUrl,
    nativeSymbol: "ETH",
    nativeMinWei: params.nativeMinWei,
    token: {
      address: getAddress(params.usdcAddress) as `0x${string}`,
      symbol: "USDC",
      decimals: 6,
      minAtomic: params.usdcMinAtomic,
    },
  }
}

export function listRuntimeWalletFundingSpecs(env: Env): RuntimeWalletFundingSpec[] {
  const nativeMinWei = positiveBigInt(env.BASE_RUNTIME_OPERATOR_MIN_BALANCE_WEI, DEFAULT_BASE_NATIVE_MIN_WEI)
  const usdcMinAtomic = positiveBigInt(env.BASE_RUNTIME_OPERATOR_MIN_USDC_ATOMIC, DEFAULT_BASE_USDC_MIN_ATOMIC)
  const specs: RuntimeWalletFundingSpec[] = []
  const storyFunder = storyFunderSpec(env)
  if (storyFunder) specs.push(storyFunder)

  if (hasAny(env, ["PIRATE_CHECKOUT_OPERATOR_ADDRESS", "PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY"])) {
    specs.push(baseSpec({
      name: "base-checkout-operator",
      address: resolvePirateCheckoutOperatorAddress(env),
      chainId: resolvePirateCheckoutSourceChainId(env),
      rpcUrl: resolvePirateCheckoutRpcUrl(env),
      usdcAddress: resolvePirateCheckoutUsdcTokenAddress(env),
      nativeMinWei,
      usdcMinAtomic,
    }))
  }
  if (hasAny(env, ["PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS", "PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY"])) {
    specs.push(baseSpec({
      name: "base-booking-operator",
      address: resolveBookingSettlementOperatorAddress(env),
      chainId: resolveBookingSettlementChainId(env),
      rpcUrl: resolveBookingSettlementRpcUrl(env),
      usdcAddress: resolveBookingSettlementUsdcTokenAddress(env),
      nativeMinWei,
      usdcMinAtomic,
    }))
  }
  if (hasAny(env, ["PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS", "PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY"])) {
    specs.push(baseSpec({
      name: "base-rewards-operator",
      address: resolveRewardsSettlementOperatorAddress(env),
      chainId: resolveRewardsSettlementChainId(env),
      rpcUrl: resolveRewardsSettlementRpcUrl(env),
      usdcAddress: resolveRewardsSettlementUsdcTokenAddress(env),
      nativeMinWei,
      usdcMinAtomic,
    }))
  }
  return specs
}

async function readNativeBalance(spec: RuntimeWalletFundingSpec): Promise<bigint> {
  const provider = new JsonRpcProvider(spec.rpcUrl, spec.chainId)
  try {
    return await provider.getBalance(spec.address)
  } finally {
    void provider.destroy()
  }
}

async function readTokenBalance(spec: RuntimeWalletFundingSpec): Promise<bigint> {
  if (!spec.token) return 0n
  const provider = new JsonRpcProvider(spec.rpcUrl, spec.chainId)
  try {
    const token = new Contract(spec.token.address, ERC20_BALANCE_ABI, provider)
    return BigInt(await token.balanceOf(spec.address))
  } finally {
    void provider.destroy()
  }
}

export async function runRuntimeWalletFundingWatchdog(
  env: Env,
  options?: {
    force?: boolean
    now?: number
    specs?: RuntimeWalletFundingSpec[]
    readNativeBalance?: (spec: RuntimeWalletFundingSpec) => Promise<bigint>
    readTokenBalance?: (spec: RuntimeWalletFundingSpec) => Promise<bigint>
  },
): Promise<{ ran: boolean; alerts: RuntimeWalletFundingAlert[] }> {
  const now = options?.now ?? Date.now()
  const intervalMs = positiveInt(env.RUNTIME_WALLET_FUNDING_WATCHDOG_INTERVAL_MS, DEFAULT_INTERVAL_MS)
  if (!options?.force && lastCheckAtMs !== null && now - lastCheckAtMs < intervalMs) {
    return { ran: false, alerts: [] }
  }
  lastCheckAtMs = now

  let specs: RuntimeWalletFundingSpec[]
  try {
    specs = options?.specs ?? listRuntimeWalletFundingSpecs(env)
  } catch (error) {
    console.error(`[${TASK}] configuration failed (fail-soft)`, error)
    return { ran: true, alerts: [] }
  }

  const nativeReader = options?.readNativeBalance ?? readNativeBalance
  const tokenReader = options?.readTokenBalance ?? readTokenBalance
  const alerts: RuntimeWalletFundingAlert[] = []
  for (const spec of specs) {
    try {
      const nativeBalance = await nativeReader(spec)
      if (nativeBalance < spec.nativeMinWei) {
        const alert: RuntimeWalletFundingAlert = {
          wallet: spec.name,
          address: spec.address,
          asset: "native",
          balance: nativeBalance,
          floor: spec.nativeMinWei,
        }
        alerts.push(alert)
        await captureScheduledWarning(
          env,
          `${spec.name} ${spec.nativeSymbol} funding is below floor — fund ${spec.address}`,
          `${TASK}:${spec.name}:native`,
          {
            wallet: spec.name,
            address: spec.address,
            explorer_url: explorerAddressUrl(spec.chainId, spec.address),
            chain_id: spec.chainId,
            asset: spec.nativeSymbol,
            balance: formatEther(nativeBalance),
            funding_floor: formatEther(spec.nativeMinWei),
          },
          { urgency: "high" },
        )
      }

      if (spec.token) {
        const tokenBalance = await tokenReader(spec)
        if (tokenBalance < spec.token.minAtomic) {
          const alert: RuntimeWalletFundingAlert = {
            wallet: spec.name,
            address: spec.address,
            asset: "USDC",
            balance: tokenBalance,
            floor: spec.token.minAtomic,
          }
          alerts.push(alert)
          await captureScheduledWarning(
            env,
            `${spec.name} USDC funding is below floor — fund ${spec.address}`,
            `${TASK}:${spec.name}:usdc`,
            {
              wallet: spec.name,
              address: spec.address,
              explorer_url: explorerAddressUrl(spec.chainId, spec.address),
              chain_id: spec.chainId,
              asset: spec.token.symbol,
              token_address: spec.token.address,
              balance: formatUnits(tokenBalance, spec.token.decimals),
              funding_floor: formatUnits(spec.token.minAtomic, spec.token.decimals),
            },
            { urgency: "high" },
          )
        }
      }
    } catch (error) {
      console.error(`[${TASK}] wallet check failed (fail-soft)`, {
        wallet: spec.name,
        address: spec.address,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { ran: true, alerts }
}
