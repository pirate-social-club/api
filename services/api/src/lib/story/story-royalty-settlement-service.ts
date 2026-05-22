import { NativeRoyaltyPolicy, StoryClient, WIP_TOKEN_ADDRESS } from "@story-protocol/core-sdk"
import { JsonRpcProvider, Wallet, getAddress } from "ethers"
import { http, zeroAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Env } from "../../env"
import { resolveDirectTxGasPolicy, sendContractTxWithPolicy } from "../evm-direct-tx"
import { parseExpectedEvmAddress } from "../evm-signer"
import { resolveStorySettlementDirectSigner } from "./story-direct-signer"
import { ensureStoryEntitlementMinterAuthorized } from "./story-runtime-authorization"
import {
  STORY_DELIVERY_CONTRACTS,
  resolveStoryChainId,
  resolveStoryRpcUrl,
  resolveStoryTxWaitTimeoutMs,
} from "./story-runtime-config"

const PURCHASE_ENTITLEMENT_TOKEN_ABI = [
  "function mintEntitlement(address to, uint256 tokenId, bytes32 purchaseRef) returns (bool)",
] as const

export type StoryRoyaltyPurchaseSettlementInput = {
  env: Env
  purchaseRef: `0x${string}`
  buyerAddress: string
  receiverIpId: string
  payerIpId?: string | null
  entitlementTokenId?: bigint | null
  amount: bigint
}

export type StoryRoyaltyPurchaseSettlementResult = {
  royaltyTxHash: string
  entitlementTxHash: string | null
  settlementTxHash: string
}

export type StoryRoyaltyPaymentResult = StoryRoyaltyPurchaseSettlementResult & {
  entitlementHandled: boolean
}

type StoryRoyaltyPurchaseSettlementTestResult =
  StoryRoyaltyPurchaseSettlementResult & { entitlementHandled?: boolean }

let testRoyaltySettlementExecutor:
  | ((input: StoryRoyaltyPurchaseSettlementInput) => Promise<StoryRoyaltyPurchaseSettlementTestResult>)
  | null = null
let testParentRoyaltyVaultTransferExecutor:
  | ((input: StoryParentRoyaltyVaultTransferInput) => Promise<StoryParentRoyaltyVaultTransferResult>)
  | null = null

export type StoryRoyaltySettlementAdapterDeps = {
  newStoryClient: typeof StoryClient.newClient
  createJsonRpcProvider: (rpcUrl: string, chainId: number) => JsonRpcProvider
  createWallet: (privateKey: string, provider: JsonRpcProvider) => Wallet
  sendContractTxWithPolicy: typeof sendContractTxWithPolicy
  ensureStoryEntitlementMinterAuthorized: typeof ensureStoryEntitlementMinterAuthorized
}

const defaultStoryRoyaltySettlementAdapterDeps: StoryRoyaltySettlementAdapterDeps = {
  newStoryClient: StoryClient.newClient,
  createJsonRpcProvider: (rpcUrl, chainId) => new JsonRpcProvider(rpcUrl, chainId),
  createWallet: (privateKey, provider) => new Wallet(privateKey, provider),
  sendContractTxWithPolicy,
  ensureStoryEntitlementMinterAuthorized,
}

let testStoryRoyaltySettlementAdapterDeps: StoryRoyaltySettlementAdapterDeps | null = null

export function setStoryRoyaltyPurchaseSettlementExecutorForTests(
  executor: ((input: StoryRoyaltyPurchaseSettlementInput) => Promise<StoryRoyaltyPurchaseSettlementTestResult>) | null,
): void {
  testRoyaltySettlementExecutor = executor
}

export function setStoryRoyaltySettlementAdapterDepsForTests(
  deps: StoryRoyaltySettlementAdapterDeps | null,
): void {
  testStoryRoyaltySettlementAdapterDeps = deps
}

export type StoryParentRoyaltyVaultTransferInput = {
  env: Env
  childIpId: string
  parentIpId: string
  royaltyPolicy?: string | null
}

export type StoryParentRoyaltyVaultTransferResult = {
  transferTxHash: string
}

export function setStoryParentRoyaltyVaultTransferExecutorForTests(
  executor: ((input: StoryParentRoyaltyVaultTransferInput) => Promise<StoryParentRoyaltyVaultTransferResult>) | null,
): void {
  testParentRoyaltyVaultTransferExecutor = executor
}

export type StoryRoyaltyPurchaseEntitlementMintInput = {
  env: Env
  purchaseRef: `0x${string}`
  buyerAddress: string
  entitlementTokenId: bigint
}

let testRoyaltyEntitlementMinter:
  | ((input: StoryRoyaltyPurchaseEntitlementMintInput) => Promise<string>)
  | null = null

export function setStoryRoyaltyEntitlementMinterForTests(
  minter: ((input: StoryRoyaltyPurchaseEntitlementMintInput) => Promise<string>) | null,
): void {
  testRoyaltyEntitlementMinter = minter
}

function resolveStoryChainName(env: Pick<Env, "STORY_CHAIN_ID">): "aeneid" | "mainnet" {
  return resolveStoryChainId(env) === 1514 ? "mainnet" : "aeneid"
}

function resolveRoyaltyPolicyInput(value: string | null | undefined): string | NativeRoyaltyPolicy {
  const policy = parseExpectedEvmAddress(value)
  return policy ?? NativeRoyaltyPolicy.LAP
}

export async function payStoryRoyaltyOnBehalfForPurchase(input: StoryRoyaltyPurchaseSettlementInput): Promise<StoryRoyaltyPaymentResult> {
  if (testRoyaltySettlementExecutor) {
    const result = await testRoyaltySettlementExecutor(input)
    return {
      ...result,
      entitlementHandled: result.entitlementHandled ?? false,
    }
  }

  const settlementConfig = resolveStorySettlementDirectSigner(input.env)
  if (!settlementConfig.ok) throw new Error(settlementConfig.error)
  if (!settlementConfig.value) {
    throw new Error("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  }

  const buyerAddress = parseExpectedEvmAddress(input.buyerAddress)
  if (!buyerAddress) throw new Error("buyerAddress missing/invalid")
  const receiverIpId = parseExpectedEvmAddress(input.receiverIpId)
  if (!receiverIpId) throw new Error("receiverIpId missing/invalid")
  const payerIpId = parseExpectedEvmAddress(input.payerIpId) ?? zeroAddress
  if (input.amount <= 0n) throw new Error("royalty settlement amount must be positive")

  const deps = testStoryRoyaltySettlementAdapterDeps ?? defaultStoryRoyaltySettlementAdapterDeps
  const storyClient = deps.newStoryClient({
    account: privateKeyToAccount(settlementConfig.value.privateKey as `0x${string}`),
    transport: http(resolveStoryRpcUrl(input.env)),
    chainId: resolveStoryChainName(input.env),
  })
  const royalty = await storyClient.royalty.payRoyaltyOnBehalf({
    receiverIpId: receiverIpId as `0x${string}`,
    payerIpId: payerIpId as `0x${string}`,
    token: WIP_TOKEN_ADDRESS,
    amount: input.amount,
    options: {
      wipOptions: {
        enableAutoWrapIp: true,
        enableAutoApprove: true,
      },
    },
  })
  const royaltyTxHash = String(royalty.txHash || "")
  if (!royaltyTxHash) {
    throw new Error("story_royalty_payment_missing_tx_hash")
  }

  return {
    royaltyTxHash,
    entitlementTxHash: null,
    settlementTxHash: royaltyTxHash,
    entitlementHandled: false,
  }
}

export async function transferStoryRoyaltyToParentVault(input: StoryParentRoyaltyVaultTransferInput): Promise<StoryParentRoyaltyVaultTransferResult> {
  if (testParentRoyaltyVaultTransferExecutor) {
    return await testParentRoyaltyVaultTransferExecutor(input)
  }

  const settlementConfig = resolveStorySettlementDirectSigner(input.env)
  if (!settlementConfig.ok) throw new Error(settlementConfig.error)
  if (!settlementConfig.value) {
    throw new Error("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  }

  const childIpId = parseExpectedEvmAddress(input.childIpId)
  if (!childIpId) throw new Error("childIpId missing/invalid")
  const parentIpId = parseExpectedEvmAddress(input.parentIpId)
  if (!parentIpId) throw new Error("parentIpId missing/invalid")

  const deps = testStoryRoyaltySettlementAdapterDeps ?? defaultStoryRoyaltySettlementAdapterDeps
  const storyClient = deps.newStoryClient({
    account: privateKeyToAccount(settlementConfig.value.privateKey as `0x${string}`),
    transport: http(resolveStoryRpcUrl(input.env)),
    chainId: resolveStoryChainName(input.env),
  })
  const transfer = await storyClient.royalty.transferToVault({
    ipId: childIpId as `0x${string}`,
    ancestorIpId: parentIpId as `0x${string}`,
    royaltyPolicy: resolveRoyaltyPolicyInput(input.royaltyPolicy) as `0x${string}` | NativeRoyaltyPolicy,
    token: WIP_TOKEN_ADDRESS,
  })
  const transferTxHash = String(transfer.txHash || "")
  if (!transferTxHash) {
    throw new Error("story_parent_royalty_vault_transfer_missing_tx_hash")
  }
  return { transferTxHash }
}

export async function mintStoryRoyaltyPurchaseEntitlement(input: {
  env: Env
  purchaseRef: `0x${string}`
  buyerAddress: string
  entitlementTokenId: bigint
}): Promise<string> {
  if (testRoyaltyEntitlementMinter) {
    return await testRoyaltyEntitlementMinter(input)
  }
  const settlementConfig = resolveStorySettlementDirectSigner(input.env)
  if (!settlementConfig.ok) throw new Error(settlementConfig.error)
  if (!settlementConfig.value) {
    throw new Error("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  }

  const buyerAddress = parseExpectedEvmAddress(input.buyerAddress)
  if (!buyerAddress) throw new Error("buyerAddress missing/invalid")
  if (input.entitlementTokenId == null) {
    throw new Error("entitlementTokenId missing/invalid")
  }

  const deps = testStoryRoyaltySettlementAdapterDeps ?? defaultStoryRoyaltySettlementAdapterDeps
  const provider = deps.createJsonRpcProvider(resolveStoryRpcUrl(input.env), resolveStoryChainId(input.env))
  const settlementSigner = deps.createWallet(settlementConfig.value.privateKey, provider)
  await deps.ensureStoryEntitlementMinterAuthorized({
    env: input.env,
    provider,
    minterAddress: settlementSigner.address,
  })
  const gasPolicy = resolveDirectTxGasPolicy({
    maxFeePerGasCapWeiRaw: input.env.STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasCapWeiRaw: input.env.STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI,
    gasLimitCapRaw: input.env.STORY_DIRECT_TX_GAS_LIMIT_MAX,
    gasEstimateBufferBpsRaw: input.env.STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS,
    maxFeePerGasCapField: "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI",
    maxPriorityFeePerGasCapField: "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI",
    gasLimitCapField: "STORY_DIRECT_TX_GAS_LIMIT_MAX",
    gasEstimateBufferBpsField: "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS",
  })
  if (!gasPolicy.ok) throw new Error(gasPolicy.error)

  const entitlementTx = await deps.sendContractTxWithPolicy({
    provider,
    signer: settlementSigner,
    contractAddress: STORY_DELIVERY_CONTRACTS.purchaseEntitlementToken,
    abi: PURCHASE_ENTITLEMENT_TOKEN_ABI,
    functionName: "mintEntitlement",
    args: [
      getAddress(buyerAddress),
      input.entitlementTokenId,
      input.purchaseRef,
    ],
    gasPolicy: gasPolicy.value,
  })
  const entitlementReceipt = await provider.waitForTransaction(
    String(entitlementTx.hash || ""),
    1,
    resolveStoryTxWaitTimeoutMs(input.env),
  )
  if (!entitlementReceipt || entitlementReceipt.status !== 1) {
    throw new Error("story_royalty_entitlement_mint_failed")
  }
  const entitlementTxHash = String(entitlementTx.hash || "")
  if (!entitlementTxHash) {
    throw new Error("story_royalty_entitlement_missing_tx_hash")
  }
  return entitlementTxHash
}
