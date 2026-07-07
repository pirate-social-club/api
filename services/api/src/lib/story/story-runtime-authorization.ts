import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers"
import type { Env } from "../../env"
import { resolveDirectTxGasPolicy, sendContractTxWithPolicy } from "../evm-direct-tx"
import { normalizeDirectSignerPrivateKey } from "./story-direct-signer"
import {
  STORY_DELIVERY_CONTRACTS,
  resolveStoryTxWaitTimeoutMs,
} from "./story-runtime-config"

const PUBLISH_COORDINATOR_ABI = [
  "function isPublishOperator(address operator) view returns (bool)",
  "function setPublishOperator(address operator, bool active)",
] as const

const MARKETPLACE_SETTLEMENT_ABI = [
  "function isSettlementOperator(address operator) view returns (bool)",
  "function setSettlementOperator(address operator, bool active)",
] as const

const PURCHASE_ENTITLEMENT_TOKEN_ABI = [
  "function isSettlementMinter(address minter) view returns (bool)",
  "function setSettlementMinter(address minter, bool active)",
] as const

const PIRATE_SIGNER_REGISTRY_ABI = [
  "function isActiveSigner(address signer) view returns (bool)",
  "function setSigner(address signer, bool active)",
] as const

function resolveOwnerPrivateKey(env: Pick<Env, "STORY_CONTRACT_OWNER_PRIVATE_KEY">): string | null {
  return normalizeDirectSignerPrivateKey(env.STORY_CONTRACT_OWNER_PRIVATE_KEY)
}

function resolveGasPolicy(env: Pick<
  Env,
  | "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI"
  | "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI"
  | "STORY_DIRECT_TX_GAS_LIMIT_MAX"
  | "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS"
>) {
  return resolveDirectTxGasPolicy({
    maxFeePerGasCapWeiRaw: env.STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasCapWeiRaw: env.STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI,
    gasLimitCapRaw: env.STORY_DIRECT_TX_GAS_LIMIT_MAX,
    gasEstimateBufferBpsRaw: env.STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS,
    maxFeePerGasCapField: "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI",
    maxPriorityFeePerGasCapField: "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI",
    gasLimitCapField: "STORY_DIRECT_TX_GAS_LIMIT_MAX",
    gasEstimateBufferBpsField: "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS",
  })
}

async function ensureOwnerAuthorizedCall(params: {
  env: Pick<
    Env,
    | "STORY_CONTRACT_OWNER_PRIVATE_KEY"
    | "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_GAS_LIMIT_MAX"
    | "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS"
    | "STORY_TX_WAIT_TIMEOUT_MS"
  >
  provider: JsonRpcProvider
  contractAddress: string
  abi: readonly string[]
  functionName: string
  args: readonly unknown[]
}): Promise<void> {
  const ownerPrivateKey = resolveOwnerPrivateKey(params.env)
  if (!ownerPrivateKey) {
    throw new Error("STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")
  }
  const gasPolicy = resolveGasPolicy(params.env)
  if (!gasPolicy.ok) throw new Error(gasPolicy.error)
  const txWaitTimeoutMs = resolveStoryTxWaitTimeoutMs(params.env)
  const ownerSigner = new Wallet(ownerPrivateKey, params.provider)
  const tx = await sendContractTxWithPolicy({
    provider: params.provider,
    signer: ownerSigner,
    contractAddress: params.contractAddress,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args,
    gasPolicy: gasPolicy.value,
    defaultWaitTimeoutMs: txWaitTimeoutMs,
  })
  const receipt = await params.provider.waitForTransaction(
    String(tx.hash || ""),
    1,
    txWaitTimeoutMs,
  )
  if (!receipt || receipt.status !== 1) {
    throw new Error(`story_runtime_authorization_failed:${params.functionName}`)
  }
}

export async function ensureStoryPublishOperatorAuthorized(params: {
  env: Pick<
    Env,
    | "STORY_CONTRACT_OWNER_PRIVATE_KEY"
    | "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_GAS_LIMIT_MAX"
    | "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS"
    | "STORY_TX_WAIT_TIMEOUT_MS"
  >
  provider: JsonRpcProvider
  operatorAddress: string
}): Promise<void> {
  const operatorAddress = getAddress(params.operatorAddress)
  const contract = new Contract(STORY_DELIVERY_CONTRACTS.assetPublishCoordinatorV1, PUBLISH_COORDINATOR_ABI, params.provider)
  const active = Boolean(await contract.isPublishOperator(operatorAddress))
  if (active) return
  await ensureOwnerAuthorizedCall({
    env: params.env,
    provider: params.provider,
    contractAddress: STORY_DELIVERY_CONTRACTS.assetPublishCoordinatorV1,
    abi: PUBLISH_COORDINATOR_ABI,
    functionName: "setPublishOperator",
    args: [operatorAddress, true],
  })
}

export async function ensureStorySettlementOperatorAuthorized(params: {
  env: Pick<
    Env,
    | "STORY_CONTRACT_OWNER_PRIVATE_KEY"
    | "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_GAS_LIMIT_MAX"
    | "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS"
    | "STORY_TX_WAIT_TIMEOUT_MS"
  >
  provider: JsonRpcProvider
  operatorAddress: string
}): Promise<void> {
  const operatorAddress = getAddress(params.operatorAddress)
  const contract = new Contract(STORY_DELIVERY_CONTRACTS.marketplaceSettlementV1, MARKETPLACE_SETTLEMENT_ABI, params.provider)
  const active = Boolean(await contract.isSettlementOperator(operatorAddress))
  if (active) return
  await ensureOwnerAuthorizedCall({
    env: params.env,
    provider: params.provider,
    contractAddress: STORY_DELIVERY_CONTRACTS.marketplaceSettlementV1,
    abi: MARKETPLACE_SETTLEMENT_ABI,
    functionName: "setSettlementOperator",
    args: [operatorAddress, true],
  })
}

export async function ensureStoryEntitlementMinterAuthorized(params: {
  env: Pick<
    Env,
    | "STORY_CONTRACT_OWNER_PRIVATE_KEY"
    | "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_GAS_LIMIT_MAX"
    | "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS"
    | "STORY_TX_WAIT_TIMEOUT_MS"
  >
  provider: JsonRpcProvider
  minterAddress: string
}): Promise<void> {
  const minterAddress = getAddress(params.minterAddress)
  const contract = new Contract(
    STORY_DELIVERY_CONTRACTS.purchaseEntitlementToken,
    PURCHASE_ENTITLEMENT_TOKEN_ABI,
    params.provider,
  )
  const active = Boolean(await contract.isSettlementMinter(minterAddress))
  if (active) return
  await ensureOwnerAuthorizedCall({
    env: params.env,
    provider: params.provider,
    contractAddress: STORY_DELIVERY_CONTRACTS.purchaseEntitlementToken,
    abi: PURCHASE_ENTITLEMENT_TOKEN_ABI,
    functionName: "setSettlementMinter",
    args: [minterAddress, true],
  })
}

export async function ensureStoryAccessSignerAuthorized(params: {
  env: Pick<
    Env,
    | "STORY_CONTRACT_OWNER_PRIVATE_KEY"
    | "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_GAS_LIMIT_MAX"
    | "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS"
    | "STORY_TX_WAIT_TIMEOUT_MS"
  >
  provider: JsonRpcProvider
  signerAddress: string
}): Promise<void> {
  const signerAddress = getAddress(params.signerAddress)
  const contract = new Contract(STORY_DELIVERY_CONTRACTS.pirateSignerRegistry, PIRATE_SIGNER_REGISTRY_ABI, params.provider)
  const active = Boolean(await contract.isActiveSigner(signerAddress))
  if (active) return
  await ensureOwnerAuthorizedCall({
    env: params.env,
    provider: params.provider,
    contractAddress: STORY_DELIVERY_CONTRACTS.pirateSignerRegistry,
    abi: PIRATE_SIGNER_REGISTRY_ABI,
    functionName: "setSigner",
    args: [signerAddress, true],
  })
}
