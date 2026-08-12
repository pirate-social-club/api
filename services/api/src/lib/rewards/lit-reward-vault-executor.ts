import {
  LitChipotleError,
  type LitActionSource,
  type LitChipotleClient,
} from "./lit-chipotle-client"
import type {
  RewardVaultActionExecutor,
  RewardVaultActionRequest,
} from "./reward-vault-transaction"

type LitActionClient = Pick<LitChipotleClient, "execute">

function decodedActionResponse(response: unknown): Record<string, unknown> {
  let decoded = response
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded)
    } catch {
      throw new LitChipotleError(
        "invalid_response",
        "Lit rewards vault action response was invalid",
        false,
      )
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new LitChipotleError(
      "invalid_response",
      "Lit rewards vault action response was invalid",
      false,
    )
  }
  return decoded as Record<string, unknown>
}

function signedTransaction(response: unknown): string {
  const decoded = decodedActionResponse(response)
  const signedTx = decoded.signedTx
  if (
    typeof signedTx !== "string"
    || !/^0x[0-9a-fA-F]+$/.test(signedTx)
    || signedTx.length % 2 !== 0
  ) {
    throw new LitChipotleError(
      "invalid_response",
      "Lit rewards vault action did not return a signed transaction",
      false,
    )
  }
  return signedTx
}

function actionParams(request: RewardVaultActionRequest): Record<string, unknown> {
  return {
    method: request.method,
    operationId: request.operationId,
    recipient: request.recipient,
    amount: request.amount,
    deadline: request.deadline,
    policyVersion: request.policyVersion,
    vaultAddress: request.vaultAddress,
    signerAddress: request.signerAddress,
    chainId: request.chainId,
    nonce: request.nonce,
    gas: request.gas,
  }
}

export function createLitRewardVaultExecutor(
  client: LitActionClient,
  source: LitActionSource,
): RewardVaultActionExecutor {
  return async (request) => {
    const response = await client.execute({
      ...source,
      jsParams: actionParams(request),
    })
    return { signedTx: signedTransaction(response) }
  }
}

/**
 * Production construction intentionally has no inline-code option. The CID is
 * the on-chain group permission boundary; production wiring must call this
 * constructor so a compromised Worker cannot substitute action source.
 */
export function createProductionLitRewardVaultExecutor(
  client: LitActionClient,
  pinnedIpfsId: string,
  pinnedPolicy: { policyVersion: bigint; maxDeadlineSeconds: number },
): RewardVaultActionExecutor {
  if (typeof pinnedIpfsId !== "string" || pinnedIpfsId.trim() !== pinnedIpfsId || !pinnedIpfsId) {
    throw new LitChipotleError(
      "invalid_request",
      "Pinned Lit rewards vault action CID is required",
      false,
    )
  }
  if (pinnedPolicy.policyVersion <= 0n || !Number.isSafeInteger(pinnedPolicy.maxDeadlineSeconds)
    || pinnedPolicy.maxDeadlineSeconds <= 0) {
    throw new LitChipotleError(
      "invalid_request",
      "Pinned Lit rewards vault action policy is invalid",
      false,
    )
  }
  const execute = createLitRewardVaultExecutor(client, { ipfsId: pinnedIpfsId })
  return async (request) => {
    if (request.policyVersion !== pinnedPolicy.policyVersion.toString()) {
      throw new LitChipotleError(
        "invalid_request",
        "Lit rewards policy version does not match the registered action CID",
        false,
        undefined,
        undefined,
        "policy_version_mismatch",
      )
    }
    let deadline: bigint
    try {
      deadline = BigInt(request.deadline)
    } catch {
      throw new LitChipotleError(
        "invalid_request",
        "Lit rewards deadline is invalid",
        false,
        undefined,
        undefined,
        "deadline_invalid",
      )
    }
    const now = BigInt(Math.floor(Date.now() / 1_000))
    if (deadline < now || deadline > now + BigInt(pinnedPolicy.maxDeadlineSeconds)) {
      throw new LitChipotleError(
        "invalid_request",
        "Lit rewards deadline is outside the registered action policy",
        false,
        undefined,
        undefined,
        "deadline_out_of_policy",
      )
    }
    return execute(request)
  }
}
