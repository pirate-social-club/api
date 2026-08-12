export const PINNED_REWARD_VAULT_ACTION_CID =
  "QmR9EqhLEK7jE1wp44wLanmeJwK3Wr3kPtsfD4pjAmogm7"

export const PINNED_REWARD_VAULT_ACTION_SHA256 =
  "59b65894559e6feb454586f5aae6342f35f2100018a72889f8fcc55d9dd20155"

export type PinnedRewardVaultActionErrorToken =
  | "request_invalid"
  | "vault_address_invalid"
  | "vault_address_mismatch"
  | "signer_address_invalid"
  | "signer_address_mismatch"
  | "chain_id_mismatch"
  | "policy_version_mismatch"
  | "method_not_permitted"
  | "operation_id_invalid"
  | "amount_invalid"
  | "deadline_invalid"
  | "deadline_out_of_policy"
  | "nonce_invalid"
  | "gas_policy_missing"
  | "max_fee_per_gas_invalid"
  | "max_priority_fee_per_gas_invalid"
  | "gas_limit_invalid"
  | "gas_policy_exceeded"
  | "pkp_signer_mismatch"

/**
 * Exact messages frozen into the registered action above. Any source change
 * creates a different CID, and the coverage test must be updated before that
 * action can acquire new error semantics.
 */
export const PINNED_REWARD_VAULT_ACTION_ERROR_TOKENS = Object.freeze({
  "request is required": "request_invalid",
  "vaultAddress is invalid": "vault_address_invalid",
  "vaultAddress does not match pinned policy": "vault_address_mismatch",
  "signerAddress is invalid": "signer_address_invalid",
  "signerAddress does not match pinned policy": "signer_address_mismatch",
  "chainId does not match pinned policy": "chain_id_mismatch",
  "policyVersion does not match pinned policy": "policy_version_mismatch",
  "method is not permitted": "method_not_permitted",
  "operationId must be bytes32": "operation_id_invalid",
  "amount must be a canonical positive integer": "amount_invalid",
  "deadline must be a canonical positive integer": "deadline_invalid",
  "deadline is outside pinned policy": "deadline_out_of_policy",
  "nonce must be a non-negative safe integer": "nonce_invalid",
  "gas policy is required": "gas_policy_missing",
  "maxFeePerGas must be a canonical positive integer": "max_fee_per_gas_invalid",
  "maxPriorityFeePerGas must be a canonical positive integer": "max_priority_fee_per_gas_invalid",
  "gasLimit must be a canonical positive integer": "gas_limit_invalid",
  "gas fields exceed pinned policy": "gas_policy_exceeded",
  "PKP signer does not match pinned policy": "pkp_signer_mismatch",
} satisfies Readonly<Record<string, PinnedRewardVaultActionErrorToken>>)

const MAX_TRAVERSED_VALUES = 64
const MAX_TRAVERSAL_DEPTH = 6
const MAX_STRING_LENGTH = 8_000
const UNCAUGHT_ERROR_PREFIX = "Uncaught Error: "

function tokenFromString(value: string): PinnedRewardVaultActionErrorToken | null {
  const bounded = value.slice(0, MAX_STRING_LENGTH)
  for (const line of bounded.split(/\r?\n/u)) {
    const normalized = line.trimStart()
    if (!normalized.startsWith(UNCAUGHT_ERROR_PREFIX)) continue
    const message = normalized.slice(UNCAUGHT_ERROR_PREFIX.length).trimEnd()
    return Object.hasOwn(PINNED_REWARD_VAULT_ACTION_ERROR_TOKENS, message)
      ? PINNED_REWARD_VAULT_ACTION_ERROR_TOKENS[
        message as keyof typeof PINNED_REWARD_VAULT_ACTION_ERROR_TOKENS
      ]
      : null
  }
  return null
}

/**
 * Provider envelopes have changed shape across Chipotle releases. Traverse a
 * tightly bounded JSON value, but emit only a token from the immutable
 * action-message allowlist. Raw provider strings never leave this function.
 */
export function pinnedRewardVaultActionErrorToken(
  input: unknown,
): PinnedRewardVaultActionErrorToken | null {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  const seen = new Set<object>()
  let traversed = 0

  while (pending.length > 0 && traversed < MAX_TRAVERSED_VALUES) {
    const current = pending.shift()
    if (!current) break
    traversed += 1

    if (typeof current.value === "string") {
      const token = tokenFromString(current.value)
      if (token) return token
      continue
    }
    if (
      !current.value
      || typeof current.value !== "object"
      || current.depth >= MAX_TRAVERSAL_DEPTH
      || seen.has(current.value)
    ) {
      continue
    }
    seen.add(current.value)
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>)
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 })
    }
  }
  return null
}
