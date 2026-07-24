import { Interface, Transaction, getAddress } from "ethers"

import type { OperatorEffectKind } from "../communities/bookings/operator-signing-coordinator-do"
import { badRequestError } from "../errors"
import { rewardOperationId } from "./reward-operation-id"

const VAULT_ABI = [
  "function pay(bytes32 operationId,address recipient,uint256 amount,uint64 deadline,uint64 expectedPolicyVersion)",
  "function refund(bytes32 operationId,address recipient,uint256 amount,uint64 deadline,uint64 expectedPolicyVersion)",
] as const

const VAULT = new Interface(VAULT_ABI)
const MAX_UINT64 = (1n << 64n) - 1n

export type RewardVaultEffectKind = Extract<
  OperatorEffectKind,
  "reward_cashout" | "reward_funding_refund"
>

export type RewardVaultTransactionInput = {
  effectKind: OperatorEffectKind
  effectId: string
  recipient: string
  amount: bigint
  deadline: bigint
  policyVersion: bigint
  vaultAddress: string
  signerAddress: string
  chainId: number
  nonce: number
  gas: {
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
    gasLimit: bigint
  }
}

export type RewardVaultActionRequest = {
  method: "pay" | "refund"
  operationId: `0x${string}`
  recipient: string
  amount: string
  deadline: string
  policyVersion: string
  vaultAddress: string
  signerAddress: string
  chainId: number
  nonce: number
  gas: {
    maxFeePerGas: string
    maxPriorityFeePerGas: string
    gasLimit: string
  }
}

export type RewardVaultActionExecutor = (
  request: RewardVaultActionRequest,
) => Promise<{ signedTx: string }>

export function rewardVaultMethod(effectKind: OperatorEffectKind): "pay" | "refund" {
  if (effectKind === "reward_cashout") return "pay"
  if (effectKind === "reward_funding_refund") return "refund"
  throw badRequestError("Lit rewards vault backend only accepts rewards effect kinds")
}

function positiveUint64(value: bigint, field: string): bigint {
  if (value <= 0n || value > MAX_UINT64) {
    throw badRequestError(`${field} must be a positive uint64`)
  }
  return value
}

function positiveAmount(value: bigint): bigint {
  if (value <= 0n) throw badRequestError("Reward vault transfer amount must be positive")
  return value
}

export function rewardVaultActionRequest(
  input: RewardVaultTransactionInput,
): RewardVaultActionRequest {
  const method = rewardVaultMethod(input.effectKind)
  return {
    method,
    operationId: rewardOperationId(input.effectId),
    recipient: getAddress(input.recipient),
    amount: positiveAmount(input.amount).toString(),
    deadline: positiveUint64(input.deadline, "Reward vault deadline").toString(),
    policyVersion: positiveUint64(input.policyVersion, "Reward vault policy version").toString(),
    vaultAddress: getAddress(input.vaultAddress),
    signerAddress: getAddress(input.signerAddress),
    chainId: input.chainId,
    nonce: input.nonce,
    gas: {
      maxFeePerGas: input.gas.maxFeePerGas.toString(),
      maxPriorityFeePerGas: input.gas.maxPriorityFeePerGas.toString(),
      gasLimit: input.gas.gasLimit.toString(),
    },
  }
}

export function encodeRewardVaultCalldata(request: RewardVaultActionRequest): string {
  return VAULT.encodeFunctionData(request.method, [
    request.operationId,
    request.recipient,
    request.amount,
    request.deadline,
    request.policyVersion,
  ])
}

export function verifySignedRewardVaultTransaction(
  signedTx: string,
  input: RewardVaultTransactionInput,
): { signedTx: string; txHash: string } {
  const expected = rewardVaultActionRequest(input)
  const parsed = Transaction.from(signedTx)

  if (!parsed.from || getAddress(parsed.from) !== expected.signerAddress) {
    throw badRequestError("signed rewards vault tx signer mismatch")
  }
  if (Number(parsed.chainId) !== expected.chainId) {
    throw badRequestError("signed rewards vault tx chainId mismatch")
  }
  if (parsed.type !== 2) throw badRequestError("signed rewards vault tx must be EIP-1559 (type 2)")
  if (parsed.value !== 0n) throw badRequestError("signed rewards vault tx must not transfer native value")
  if (
    parsed.maxFeePerGas !== input.gas.maxFeePerGas
    || parsed.maxPriorityFeePerGas !== input.gas.maxPriorityFeePerGas
    || parsed.gasLimit !== input.gas.gasLimit
  ) {
    throw badRequestError("signed rewards vault tx gas fields mismatch")
  }
  if (!parsed.to || getAddress(parsed.to) !== expected.vaultAddress) {
    throw badRequestError("signed rewards vault tx vault mismatch")
  }
  if (Number(parsed.nonce) !== expected.nonce) {
    throw badRequestError("signed rewards vault tx nonce mismatch")
  }
  if (parsed.data !== encodeRewardVaultCalldata(expected)) {
    throw badRequestError("signed rewards vault tx calldata mismatch")
  }
  if (!parsed.hash) throw badRequestError("signed rewards vault tx missing hash")
  return { signedTx, txHash: parsed.hash }
}

export async function executeAndVerifyRewardVaultTransaction(
  executeAction: RewardVaultActionExecutor,
  input: RewardVaultTransactionInput,
): Promise<{ signedTx: string; txHash: string }> {
  // Validate the effect domain and every caller-controlled field before making
  // a metered external Lit request.
  const request = rewardVaultActionRequest(input)
  const result = await executeAction(request)
  return verifySignedRewardVaultTransaction(result.signedTx, input)
}
