import { getAddress } from "ethers"

import { badRequestError } from "../errors"

export type RewardVaultLitActionPolicy = {
  vaultAddress: string
  signerAddress: string
  chainId: number
  policyVersion: bigint
  maxDeadlineSeconds: number
  maxFeePerGasWei: bigint
  maxPriorityFeePerGasWei: bigint
  maxGasLimit: bigint
}

function positiveBigInt(value: bigint, field: string): string {
  if (value <= 0n) throw badRequestError(`${field} must be positive`)
  return value.toString()
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw badRequestError(`${field} must be a positive safe integer`)
  }
  return value
}

/**
 * Builds the immutable Lit Action source. Security-critical destination and
 * signing policy values are source constants, so changing one changes the CID.
 * Caller-supplied js_params are cross-checks only.
 */
export function buildRewardVaultLitAction(policy: RewardVaultLitActionPolicy): string {
  const pinned = {
    vaultAddress: getAddress(policy.vaultAddress),
    signerAddress: getAddress(policy.signerAddress),
    chainId: positiveInteger(policy.chainId, "Lit rewards chain ID"),
    policyVersion: positiveBigInt(policy.policyVersion, "Lit rewards policy version"),
    maxDeadlineSeconds: positiveInteger(
      policy.maxDeadlineSeconds,
      "Lit rewards maximum deadline",
    ),
    maxFeePerGasWei: positiveBigInt(policy.maxFeePerGasWei, "Lit rewards max fee"),
    maxPriorityFeePerGasWei: positiveBigInt(
      policy.maxPriorityFeePerGasWei,
      "Lit rewards max priority fee",
    ),
    maxGasLimit: positiveBigInt(policy.maxGasLimit, "Lit rewards max gas limit"),
  }
  if (BigInt(pinned.maxPriorityFeePerGasWei) > BigInt(pinned.maxFeePerGasWei)) {
    throw badRequestError("Lit rewards max priority fee cannot exceed max fee")
  }

  return `
const REWARDS_VAULT_POLICY = Object.freeze(${JSON.stringify(pinned)});
const REWARDS_VAULT_ABI = [
  "function pay(bytes32 operationId,address recipient,uint256 amount,uint64 deadline,uint64 expectedPolicyVersion)",
  "function refund(bytes32 operationId,address recipient,uint256 amount,uint64 deadline,uint64 expectedPolicyVersion)",
];

function canonicalPositiveInteger(value, field) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(field + " must be a canonical positive integer");
  }
  return BigInt(value);
}

function sameAddress(actual, expected, field) {
  let normalized;
  try {
    normalized = ethers.utils.getAddress(actual);
  } catch {
    throw new Error(field + " is invalid");
  }
  if (normalized !== expected) throw new Error(field + " does not match pinned policy");
  return normalized;
}

async function main(input) {
  if (!input || typeof input !== "object") throw new Error("request is required");

  const vaultAddress = sameAddress(
    input.vaultAddress,
    REWARDS_VAULT_POLICY.vaultAddress,
    "vaultAddress",
  );
  const signerAddress = sameAddress(
    input.signerAddress,
    REWARDS_VAULT_POLICY.signerAddress,
    "signerAddress",
  );
  if (input.chainId !== REWARDS_VAULT_POLICY.chainId) {
    throw new Error("chainId does not match pinned policy");
  }
  if (input.policyVersion !== REWARDS_VAULT_POLICY.policyVersion) {
    throw new Error("policyVersion does not match pinned policy");
  }
  if (input.method !== "pay" && input.method !== "refund") {
    throw new Error("method is not permitted");
  }
  if (typeof input.operationId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.operationId)) {
    throw new Error("operationId must be bytes32");
  }
  const recipient = ethers.utils.getAddress(input.recipient);
  const amount = canonicalPositiveInteger(input.amount, "amount");
  const deadline = canonicalPositiveInteger(input.deadline, "deadline");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline < now || deadline > now + BigInt(REWARDS_VAULT_POLICY.maxDeadlineSeconds)) {
    throw new Error("deadline is outside pinned policy");
  }
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) {
    throw new Error("nonce must be a non-negative safe integer");
  }
  if (!input.gas || typeof input.gas !== "object") throw new Error("gas policy is required");
  const maxFeePerGas = canonicalPositiveInteger(input.gas.maxFeePerGas, "maxFeePerGas");
  const maxPriorityFeePerGas = canonicalPositiveInteger(
    input.gas.maxPriorityFeePerGas,
    "maxPriorityFeePerGas",
  );
  const gasLimit = canonicalPositiveInteger(input.gas.gasLimit, "gasLimit");
  if (
    maxFeePerGas > BigInt(REWARDS_VAULT_POLICY.maxFeePerGasWei)
    || maxPriorityFeePerGas > BigInt(REWARDS_VAULT_POLICY.maxPriorityFeePerGasWei)
    || maxPriorityFeePerGas > maxFeePerGas
    || gasLimit > BigInt(REWARDS_VAULT_POLICY.maxGasLimit)
  ) {
    throw new Error("gas fields exceed pinned policy");
  }

  const privateKey = await Lit.Actions.getPrivateKey({
    pkpId: REWARDS_VAULT_POLICY.signerAddress,
  });
  const wallet = new ethers.Wallet(privateKey);
  if (ethers.utils.getAddress(wallet.address) !== signerAddress) {
    throw new Error("PKP signer does not match pinned policy");
  }
  const iface = new ethers.utils.Interface(REWARDS_VAULT_ABI);
  const data = iface.encodeFunctionData(input.method, [
    input.operationId,
    recipient,
    amount.toString(),
    deadline.toString(),
    input.policyVersion,
  ]);
  const signedTx = await wallet.signTransaction({
    to: vaultAddress,
    data,
    nonce: input.nonce,
    chainId: REWARDS_VAULT_POLICY.chainId,
    type: 2,
    value: 0,
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    gasLimit: gasLimit.toString(),
  });
  return { signedTx };
}
`.trim()
}
