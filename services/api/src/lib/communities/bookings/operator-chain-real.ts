import { Contract, JsonRpcProvider, Transaction, Wallet, getAddress } from "ethers"

import type { Env } from "../../../env"
import { badRequestError } from "../../errors"
import { assertPrivateKeyMatchesExpectedAddress, parseExpectedEvmAddress } from "../../evm-signer"
import {
  resolveBookingSettlementChainId,
  resolveBookingSettlementOperatorPrivateKey,
  resolveBookingSettlementRpcUrl,
  resolveBookingSettlementUsdcTokenAddress,
  resolveRewardsSettlementChainId,
  resolveRewardsSettlementOperatorAddress,
  resolveRewardsSettlementOperatorPrivateKey,
  resolveRewardsSettlementRpcUrl,
  resolveRewardsSettlementUsdcTokenAddress,
} from "./booking-chain-config"
import {
  OperatorPreparationError,
  type ChainPrimitives,
  type OperatorKind,
  type PreparationFailureStage,
} from "./operator-signing-coordinator-do"
import { LitChipotleClient, LitChipotleError } from "../../rewards/lit-chipotle-client"
import { decideRewardVaultReceipt } from "../../rewards/reward-vault-receipt-decision"
import { fetchRewardVaultReceiptSnapshot } from "../../rewards/reward-vault-receipt-snapshot"
import { createProductionLitRewardVaultExecutor } from "../../rewards/lit-reward-vault-executor"
import {
  resolveRewardsSettlementBackend,
  resolveRewardVaultConfig,
  resolveRewardVaultLitConfig,
  rewardVaultSigningDeadline,
  type RewardsSettlementBackend,
} from "../../rewards/reward-vault-lit-config"
import {
  encodeRewardVaultCalldata,
  executeAndVerifyRewardVaultTransaction,
  rewardVaultInputFromSignedEffect,
  type RewardVaultActionExecutor,
} from "../../rewards/reward-vault-transaction"
import { rewardOperationId } from "../../rewards/reward-operation-id"
import {
  gatherRewardVaultRevertEvidence,
  REWARD_VAULT_TRACE_OPTIONS,
} from "../../rewards/reward-vault-revert-evidence"

// Real ethers-backed implementation of the coordinator's chain seam. Kept in a SEPARATE module so
// the DO module itself has no ethers import — the production worker entry registers this via
// registerOperatorChainPrimitives(), while test worker bundles omit it (and inject a fake seam),
// keeping ethers (and its `ws` transitive cycle under miniflare) out of the test bundle.

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
] as const
const ERC20 = new Contract("0x0000000000000000000000000000000000000000", ERC20_ABI)
const REWARD_VAULT_CAPACITY_ABI = [
  "function epochDuration() view returns (uint64)",
  "function settlementOperator() view returns (address)",
] as const

function resolveConfig(env: Env, operatorKind: OperatorKind = "booking"): {
  backend: RewardsSettlementBackend
  privateKey: string | null
  operatorAddress: string
  rpcUrl: string
  chainId: number
  usdc: string
  operatorAddressField: "PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS" | "PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS"
} {
  const backend = operatorKind === "rewards" ? resolveRewardsSettlementBackend(env) : "local"
  const privateKey = backend !== "lit_vault"
    ? (operatorKind === "rewards"
        ? resolveRewardsSettlementOperatorPrivateKey(env)
        : resolveBookingSettlementOperatorPrivateKey(env))
    : null
  // Last-line guard on the signing path: if an operator address is configured (it names the nonce DO),
  // the key we are about to sign with MUST derive it — otherwise refuse to sign rather than broadcast
  // from a wallet whose nonce is being tracked under a different DO.
  const operatorAddressField = operatorKind === "rewards" ? "PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS" : "PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS"
  const expectedOperator = parseExpectedEvmAddress(env[operatorAddressField])
  if (expectedOperator && privateKey) {
    assertPrivateKeyMatchesExpectedAddress({
      privateKey,
      expectedAddress: expectedOperator,
      expectedField: operatorAddressField,
    })
  }
  return {
    backend,
    privateKey,
    operatorAddress: operatorKind === "rewards"
      ? resolveRewardsSettlementOperatorAddress(env)
      : (privateKey ? getAddress(new Wallet(privateKey).address) : getAddress(expectedOperator!)),
    rpcUrl: operatorKind === "rewards" ? resolveRewardsSettlementRpcUrl(env) : resolveBookingSettlementRpcUrl(env),
    chainId: operatorKind === "rewards" ? resolveRewardsSettlementChainId(env) : resolveBookingSettlementChainId(env),
    usdc: operatorKind === "rewards" ? resolveRewardsSettlementUsdcTokenAddress(env) : resolveBookingSettlementUsdcTokenAddress(env),
    operatorAddressField,
  }
}
function checksumRecipient(raw: string): string {
  const a = parseExpectedEvmAddress(raw)
  if (!a) throw badRequestError("Booking settlement recipient address is invalid")
  return getAddress(a)
}
function centsToAtomic(amountCents: number): bigint {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw badRequestError("Booking settlement amount must be positive")
  return BigInt(amountCents) * 10_000n
}
function transferAmount(input: { amountCents?: number; amountAtomic?: string }): bigint {
  if (input.amountAtomic != null) {
    if (input.amountCents != null) throw badRequestError("Operator transfer amount is ambiguous")
    try {
      const amount = BigInt(input.amountAtomic)
      if (amount <= 0n || amount.toString() !== input.amountAtomic) throw new Error("invalid")
      return amount
    } catch {
      throw badRequestError("Operator transfer atomic amount must be a positive canonical integer")
    }
  }
  if (input.amountCents == null) throw badRequestError("Operator transfer amount is missing")
  return centsToAtomic(input.amountCents)
}

function preparationError(
  stage: PreparationFailureStage,
  error: unknown,
  startedAt: number,
): OperatorPreparationError {
  return new OperatorPreparationError(stage, error, Math.max(0, Math.round(performance.now() - startedAt)))
}

export function createStaticSettlementProvider(rpcUrl: string, chainId: number): JsonRpcProvider {
  // The chain ID is an explicit, validated settlement policy input. Mark it
  // static so ethers does not prepend an eth_chainId detection request to
  // every short-lived Worker provider; that probe intermittently fails at the
  // public Base RPC before the requested nonce/read call is attempted.
  return new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true })
}

function providerFor(config: Pick<ReturnType<typeof resolveConfig>, "rpcUrl" | "chainId">): JsonRpcProvider {
  return createStaticSettlementProvider(config.rpcUrl, config.chainId)
}

let rewardVaultOperatorReaderForTests:
  | ((vaultAddress: string, config: ReturnType<typeof resolveConfig>) => Promise<string>)
  | null = null

export function setRewardVaultOperatorReaderForTests(
  reader: typeof rewardVaultOperatorReaderForTests,
): void {
  rewardVaultOperatorReaderForTests = reader
}

async function readRewardVaultOperator(
  vaultAddress: string,
  config: ReturnType<typeof resolveConfig>,
): Promise<string> {
  if (rewardVaultOperatorReaderForTests) {
    return getAddress(await rewardVaultOperatorReaderForTests(vaultAddress, config))
  }
  const eoaProvider = providerFor(config)
  try {
    const configuredVault = new Contract(
      vaultAddress,
      REWARD_VAULT_CAPACITY_ABI,
      eoaProvider,
    )
    return getAddress(await configuredVault.settlementOperator() as string)
  } finally {
    void eoaProvider.destroy()
  }
}

function litFailureStage(error: unknown): PreparationFailureStage {
  if (!(error instanceof LitChipotleError)) return "transaction_verification"
  return error.code === "network" || error.code === "timeout"
    ? "lit_request_dispatch"
    : "lit_response"
}

export function settlementGasLimit(env: Env, backend: RewardsSettlementBackend): bigint {
  return backend !== "local"
    ? resolveRewardVaultConfig(env).maxGasLimit
    : 100_000n
}

export const realChain: ChainPrimitives = {
  pendingNonce: async (env, operatorKind) => { const c = resolveConfig(env, operatorKind); return providerFor(c).getTransactionCount(c.operatorAddress, "pending") },
  latestNonce: async (env, operatorKind) => { const c = resolveConfig(env, operatorKind); return providerFor(c).getTransactionCount(c.operatorAddress, "latest") },
  gasParams: async (env, operatorKind) => {
    const c = resolveConfig(env, operatorKind)
    const fee = await providerFor(c).getFeeData()
    return {
      maxFeePerGas: fee.maxFeePerGas ?? 2_000_000_000n,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 1_000_000_000n,
      gasLimit: settlementGasLimit(env, c.backend),
    }
  },
  signVerifiedTransfer: async (env, input) => {
    const startedAt = performance.now()
    let c: ReturnType<typeof resolveConfig>
    try {
      c = resolveConfig(env, input.operatorKind)
    } catch (error) {
      throw preparationError("config_resolution", error, startedAt)
    }
    const to = checksumRecipient(input.to)
    const amount = transferAmount(input)
    if (c.backend !== "local") {
      let vault: ReturnType<typeof resolveRewardVaultConfig>
      try {
        vault = resolveRewardVaultConfig(env)
      } catch (error) {
        throw preparationError("config_resolution", error, startedAt)
      }
      const execute = c.backend === "lit_vault"
        ? (() => {
            const lit = resolveRewardVaultLitConfig(env)
            const client = new LitChipotleClient({
              usageApiKey: lit.usageApiKey,
              baseUrl: lit.apiUrl,
              timeoutMs: lit.requestTimeoutMs,
              maxAttempts: lit.requestMaxAttempts,
            })
            return createProductionLitRewardVaultExecutor(client, lit.actionIpfsId, {
              policyVersion: lit.actionPolicyVersion,
              maxDeadlineSeconds: lit.signingDeadlineSeconds,
            })
          })()
        : (async (request) => {
            if (!c.privateKey) throw badRequestError("EOA vault settlement signer is not configured")
            const signer = new Wallet(c.privateKey)
            const onchainOperator = await readRewardVaultOperator(request.vaultAddress, c)
            if (onchainOperator !== getAddress(request.signerAddress)) {
              throw badRequestError(
                "Rewards vault settlement operator does not match the configured signer",
              )
            }
            return {
              signedTx: await signer.signTransaction({
                to: request.vaultAddress,
                data: encodeRewardVaultCalldata(request),
                nonce: request.nonce,
                chainId: request.chainId,
                type: 2,
                value: 0,
                maxFeePerGas: request.gas.maxFeePerGas,
                maxPriorityFeePerGas: request.gas.maxPriorityFeePerGas,
                gasLimit: request.gas.gasLimit,
              }),
            }
          }) satisfies RewardVaultActionExecutor
      // Deadline is intentionally created at the signing attempt, not when the
      // effect is enqueued. A stale/queued effect can be safely re-signed with
      // fresh calldata because the vault replay key remains the operation ID.
      const deadline = rewardVaultSigningDeadline(Date.now(), vault.signingDeadlineSeconds)
      if (input.rehearsalScenario && env.ENVIRONMENT !== "staging") {
        throw preparationError(
          "config_resolution",
          new Error("Rewards rehearsal fixture is staging-only"),
          startedAt,
        )
      }
      const rehearsalDeadline = input.rehearsalScenario === "deadline_expired"
        ? BigInt(Math.floor(Date.now() / 1_000) - 1)
        : deadline
      const rehearsalPolicyVersion = input.rehearsalScenario === "stale_policy"
        ? vault.policyVersion + 1n
        : vault.policyVersion
      let verified: Awaited<ReturnType<typeof executeAndVerifyRewardVaultTransaction>>
      try {
        verified = await executeAndVerifyRewardVaultTransaction(execute, {
          effectKind: input.effectKind,
          effectId: input.effectId,
          recipient: to,
          amount,
          deadline: rehearsalDeadline,
          policyVersion: rehearsalPolicyVersion,
          vaultAddress: vault.vaultAddress,
          signerAddress: c.operatorAddress,
          chainId: c.chainId,
          nonce: input.nonce,
          gas: input.gas,
        })
      } catch (error) {
        throw preparationError(litFailureStage(error), error, startedAt)
      }
      return { ...verified, operationId: rewardOperationId(input.effectId) }
    }
    if (!c.privateKey) throw badRequestError("Local settlement signer is not configured")
    const signer = new Wallet(c.privateKey, providerFor(c))
    const usdc = new Contract(c.usdc, ERC20_ABI, signer)
    // The amount math assumes 6 decimals — verify the token actually is, so a misconfigured token
    // address can never transfer the wrong order of magnitude.
    if (Number(await usdc.decimals()) !== 6) throw badRequestError("Booking settlement token must be USDC with 6 decimals")
    if ((await usdc.balanceOf(signer.address) as bigint) < amount) throw badRequestError("Booking settlement operator has insufficient USDC")
    const data = usdc.interface.encodeFunctionData("transfer", [to, amount])
    const signedTx = await signer.signTransaction({
      to: c.usdc, data, nonce: input.nonce, chainId: c.chainId, type: 2, value: 0,
      maxFeePerGas: input.gas.maxFeePerGas, maxPriorityFeePerGas: input.gas.maxPriorityFeePerGas, gasLimit: input.gas.gasLimit,
    })
    const parsed = Transaction.from(signedTx)
    if (!parsed.from || getAddress(parsed.from) !== signer.address) throw badRequestError("signed tx signer mismatch")
    if (Number(parsed.chainId) !== c.chainId) throw badRequestError("signed tx chainId mismatch")
    if (parsed.type !== 2) throw badRequestError("signed tx must be EIP-1559 (type 2)")
    if (parsed.value !== 0n) throw badRequestError("signed tx must not transfer native value")
    if (parsed.maxFeePerGas !== input.gas.maxFeePerGas || parsed.maxPriorityFeePerGas !== input.gas.maxPriorityFeePerGas || parsed.gasLimit !== input.gas.gasLimit) {
      throw badRequestError("signed tx gas fields mismatch")
    }
    if (!parsed.to || getAddress(parsed.to) !== getAddress(c.usdc)) throw badRequestError("signed tx token contract mismatch")
    if (Number(parsed.nonce) !== input.nonce) throw badRequestError("signed tx nonce mismatch")
    const decoded = ERC20.interface.decodeFunctionData("transfer", parsed.data)
    if (getAddress(decoded[0] as string) !== to) throw badRequestError("signed tx recipient mismatch")
    if (BigInt(decoded[1] as bigint) !== amount) throw badRequestError("signed tx amount mismatch")
    if (!parsed.hash) throw badRequestError("signed tx missing hash")
    return {
      signedTx,
      txHash: parsed.hash,
      operationId: input.operatorKind === "rewards" ? rewardOperationId(input.effectId) : null,
    }
  },
  broadcast: async (env, input) => { const c = resolveConfig(env, input.operatorKind); await providerFor(c).broadcastTransaction(input.signedTx) },
  txLiveness: async (env, txHash, operatorKind) => {
    const c = resolveConfig(env, operatorKind)
    const provider = providerFor(c)
    const receipt = await provider.getTransactionReceipt(txHash)
    if (receipt) return receipt.status === 1 ? "success" : "failed"
    return (await provider.getTransaction(txHash)) ? "pending" : "absent"
  },
  rewardVaultFailureEvidence: async (env, input) => {
    const c = resolveConfig(env, "rewards")
    if (c.backend === "local") {
      return {
        disposition: "reconciliation_required" as const,
        reason: "rewards backend is not vault-backed",
        retryAfterMs: null,
        compactEvidence: null,
      }
    }
    const lit = resolveRewardVaultConfig(env)
    const provider = providerFor(c)
    try {
      const receipt = await provider.getTransactionReceipt(input.txHash)
      if (!receipt || receipt.status !== 0 || !receipt.blockHash) {
        return {
          disposition: "reconciliation_required" as const,
          reason: "failed receipt with canonical block identity is unavailable",
          retryAfterMs: null,
          compactEvidence: null,
        }
      }
      const transactionInput = rewardVaultInputFromSignedEffect({
        signedTx: input.signedTx,
        effectKind: input.effectKind,
        effectId: input.effectId,
        recipient: input.recipient,
        amount: input.amountAtomic == null
          ? BigInt(input.amountCents ?? 0) * 10_000n
          : BigInt(input.amountAtomic),
        vaultAddress: lit.vaultAddress,
        signerAddress: resolveRewardsSettlementOperatorAddress(env),
        chainId: c.chainId,
      })
      const evidence = await gatherRewardVaultRevertEvidence({
        pinnedVaultAddress: lit.vaultAddress,
        operatorKind: "rewards",
        effectKind: input.effectKind,
        signedTx: input.signedTx,
        transactionInput,
        receiptStatus: receipt.status,
        receiptTransactionHash: receipt.hash,
        receiptBlockHash: receipt.blockHash,
        tracer: {
          traceTransaction: async (txHash) => {
            const trace = await provider.send("debug_traceTransaction", [
              txHash,
              REWARD_VAULT_TRACE_OPTIONS,
            ]) as { to?: unknown; error?: unknown; output?: unknown }
            return {
              to: typeof trace.to === "string" ? trace.to : null,
              reverted: typeof trace.error === "string" && trace.error.length > 0,
              output: typeof trace.output === "string" ? trace.output : null,
            }
          },
        },
      })
      if (!evidence.evidence) {
        return {
          disposition: "reconciliation_required" as const,
          reason: evidence.reason,
          retryAfterMs: null,
          compactEvidence: null,
        }
      }
      const compactEvidence = {
        transactionHash: evidence.evidence.transactionHash,
        blockHash: evidence.evidence.blockHash,
        selector: evidence.evidence.selector,
        errorName: evidence.errorName,
        classifiedAt: evidence.evidence.classifiedAt,
      }
      if (evidence.disposition !== "capacity_deferred") {
        return {
          disposition: "reconciliation_required" as const,
          reason: evidence.reason,
          retryAfterMs: null,
          compactEvidence,
        }
      }
      const block = await provider.getBlock(receipt.blockHash)
      if (!block) throw new Error("failed receipt block is unavailable")
      const vault = new Contract(lit.vaultAddress, REWARD_VAULT_CAPACITY_ABI, provider)
      const epochDuration = BigInt(await vault.epochDuration())
      if (epochDuration <= 0n) throw new Error("vault epoch duration is invalid")
      const nextEpochSeconds = ((BigInt(block.timestamp) / epochDuration) + 1n) * epochDuration
      const retryAfterMs = Number(nextEpochSeconds * 1_000n + 1_000n)
      if (!Number.isSafeInteger(retryAfterMs)) throw new Error("vault epoch retry time is invalid")
      return {
        disposition: "capacity_deferred" as const,
        reason: evidence.reason,
        retryAfterMs,
        compactEvidence,
      }
    } catch {
      return {
        disposition: "reconciliation_required" as const,
        reason: "exact rewards vault failure trace was unavailable or invalid",
        retryAfterMs: null,
        compactEvidence: null,
      }
    } finally {
      void provider.destroy()
    }
  },
  rewardVaultDecision: async (env, input) => {
    const c = resolveConfig(env, "rewards")
    if (c.backend === "local") {
      return {
        disposition: "reconciliation_required",
        reason: "rewards backend is not vault-backed",
        evidence: null,
      }
    }
    const lit = resolveRewardVaultConfig(env)
    const provider = providerFor(c)
    try {
    const snapshot = await fetchRewardVaultReceiptSnapshot(
      {
        getTransactionReceipt: (txHash) => provider.getTransactionReceipt(txHash) as never,
        // Bound to a hash on purpose: the fetcher has no path to a timestamp
        // from anything but the receipt's own block.
        getBlock: (blockHash) => provider.getBlock(blockHash) as never,
      },
      input.txHash,
    )
    if (snapshot.status !== "snapshot") {
      return { disposition: "reconciliation_required", reason: snapshot.reason, evidence: null }
    }
    let epochDurationSeconds: bigint
    try {
      const vault = new Contract(lit.vaultAddress, REWARD_VAULT_CAPACITY_ABI, provider)
      epochDurationSeconds = BigInt(await vault.epochDuration())
    } catch {
      return {
        disposition: "reconciliation_required",
        reason: "vault epoch duration could not be read",
        evidence: null,
      }
    }
    if (epochDurationSeconds <= 0n) {
      return {
        disposition: "reconciliation_required",
        reason: "vault epoch duration is not positive",
        evidence: null,
      }
    }
    return decideRewardVaultReceipt({
      snapshot: snapshot.snapshot,
      durable: {
        effectKind: input.effectKind,
        effectId: input.effectId,
        recipient: input.recipient,
        amountAtomic: transferAmount(input),
        nonce: input.nonce,
        signedTx: input.signedTx,
        txHash: input.txHash,
      },
      pinned: {
        vaultAddress: lit.vaultAddress,
        signerAddress: c.operatorAddress,
        chainId: c.chainId,
        policyVersion: lit.policyVersion,
        // Read from the pinned vault itself, so there is no local epoch value
        // that could silently disagree with the contract.
        epochDurationSeconds: epochDurationSeconds,
        maxFeePerGasWei: lit.maxFeePerGasWei,
        maxPriorityFeePerGasWei: lit.maxPriorityFeePerGasWei,
        maxGasLimit: lit.maxGasLimit,
      },
    })
    } finally {
      // Mirror the sibling chain method: release the RPC connection.
      void provider.destroy()
    }
  },
}
