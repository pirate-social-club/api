/**
 * Classifies a reverted rewards-vault transaction.
 *
 * A receipt with `status === 0` is not enough information to decide anything.
 * Exactly one vault failure mode — the epoch capacity ceiling — is a *deferral*:
 * the operation was well-formed and will succeed unchanged once the epoch rolls.
 * Every other revert is a real problem that must surface for reconciliation.
 *
 * Why this matters more than it looks: if a capacity revert is ever recorded as
 * `failed_onchain`, a user can cash out again. The replacement cashout mints a
 * fresh effect ID and therefore a fresh `operationId`, so the vault's replay
 * protection does not block it and the reward is paid twice.
 *
 * The classification is deliberately fail-closed. Only the exact recognized
 * capacity selector defers; unknown, empty, or malformed revert data stays
 * `reconciliation_required` until a human proves otherwise. That prevents a
 * pause, stale policy version, replay, wrong recipient, or malformed call from
 * being silently retried forever.
 */

/** Selectors for `RewardsTreasuryVault` custom errors, keccak256(signature)[0..4). */
const VAULT_ERROR_SELECTORS: Record<string, string> = {
  "0x2b579c17": "EpochLimitExceeded",
  "0x3525bb0b": "TransferLimitExceeded",
  "0xe5c91771": "StalePolicy",
  "0x1ab7da6b": "DeadlineExpired",
  "0x01828959": "OperationAlreadyUsed",
  "0x373a363f": "PayoutsPaused",
  "0xcfd11eb6": "RefundsPaused",
  "0x82b42900": "Unauthorized",
  "0x1f2a2005": "ZeroAmount",
  "0xd92e233d": "ZeroAddress",
  "0x045c4b02": "TokenTransferFailed",
  "0xab143c06": "Reentrancy",
  "0xd06b96b1": "InvalidPolicy",
  // Solidity built-ins, recognized for observability only.
  "0x08c379a0": "Error(string)",
  "0x4e487b71": "Panic(uint256)",
}

/**
 * The ONLY selector that may defer.
 *
 * `TransferLimitExceeded` is deliberately excluded even though it reads as a
 * limit: it is a per-transfer policy violation, so an unchanged retry fails
 * identically every epoch forever. It must surface, not spin.
 */
const CAPACITY_DEFERRABLE_SELECTOR = "0x2b579c17"

export type RewardVaultRevertDisposition = "capacity_deferred" | "reconciliation_required"

export type RewardVaultRevertClassification = {
  disposition: RewardVaultRevertDisposition
  /** Vault error name when recognized, else null. For alerting and audit only. */
  errorName: string | null
  selector: string | null
  reason: string
}

function normalizeSelector(revertData: string): string | null {
  if (!/^0x[0-9a-fA-F]*$/.test(revertData)) return null
  // A selector is 4 bytes; anything shorter carries no identifiable error.
  if (revertData.length < 10) return null
  return revertData.slice(0, 10).toLowerCase()
}

/**
 * Classifies raw revert return data from a failed vault call.
 *
 * `revertData` is the raw bytes the call reverted with. Null/undefined means the
 * node returned no revert reason, which is indistinguishable from an unknown
 * failure and therefore never defers.
 */
export function classifyRewardVaultRevert(
  revertData: string | null | undefined,
): RewardVaultRevertClassification {
  if (revertData === null || revertData === undefined || revertData === "" || revertData === "0x") {
    return {
      disposition: "reconciliation_required",
      errorName: null,
      selector: null,
      reason: "vault reverted without return data; cause unproven",
    }
  }

  const selector = normalizeSelector(revertData)
  if (!selector) {
    return {
      disposition: "reconciliation_required",
      errorName: null,
      selector: null,
      reason: "vault revert data was malformed or too short to identify",
    }
  }

  const errorName = VAULT_ERROR_SELECTORS[selector] ?? null

  if (selector === CAPACITY_DEFERRABLE_SELECTOR) {
    return {
      disposition: "capacity_deferred",
      errorName,
      selector,
      reason: "vault epoch capacity exhausted; operation is unchanged and retryable next epoch",
    }
  }

  return {
    disposition: "reconciliation_required",
    errorName,
    selector,
    reason: errorName
      ? `vault reverted with ${errorName}; not a capacity condition`
      : "vault reverted with an unrecognized selector; cause unproven",
  }
}

/**
 * True only for the capacity condition. Callers that merely need the retry
 * decision should use this rather than string-matching the disposition.
 */
export function isRewardVaultCapacityDeferral(revertData: string | null | undefined): boolean {
  return classifyRewardVaultRevert(revertData).disposition === "capacity_deferred"
}
