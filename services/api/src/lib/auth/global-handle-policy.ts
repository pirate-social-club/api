import { badRequestError, eligibilityFailed } from "../errors"
import type { GlobalHandle, HandleUpgradeQuote } from "../../types"

const GLOBAL_HANDLE_SUFFIX = ".pirate"
const FREE_CLEANUP_RENAME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const STANDARD_HANDLE_UPGRADE_PRICE_USD = 20
const PREMIUM_7_HANDLE_UPGRADE_PRICE_USD = 250
const RESERVED_GLOBAL_HANDLE_LABELS = new Set([
  "admin",
  "support",
  "pirate",
  "help",
  "mod",
  "staff",
  "official",
  "security",
])

const GLOBAL_HANDLE_LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type ValidateDesiredGlobalHandleLabelResult =
  | { valid: true; labelNormalized: string; labelDisplay: string }
  | { valid: false }

export function validateDesiredGlobalHandleLabel(desiredLabel: string): ValidateDesiredGlobalHandleLabelResult {
  const trimmed = desiredLabel.trim().toLowerCase()
  const withoutSuffix = trimmed.endsWith(GLOBAL_HANDLE_SUFFIX)
    ? trimmed.slice(0, -GLOBAL_HANDLE_SUFFIX.length)
    : trimmed

  if (!withoutSuffix || !GLOBAL_HANDLE_LABEL_PATTERN.test(withoutSuffix)) {
    return { valid: false }
  }

  return {
    valid: true,
    labelNormalized: withoutSuffix,
    labelDisplay: `${withoutSuffix}${GLOBAL_HANDLE_SUFFIX}`,
  }
}

export function normalizeDesiredGlobalHandleLabel(desiredLabel: string): {
  labelNormalized: string
  labelDisplay: string
} {
  const result = validateDesiredGlobalHandleLabel(desiredLabel)
  if (!result.valid) {
    throw badRequestError("Invalid desired_label")
  }
  return { labelNormalized: result.labelNormalized, labelDisplay: result.labelDisplay }
}

export function isReservedGlobalHandleLabel(labelNormalized: string): boolean {
  return RESERVED_GLOBAL_HANDLE_LABELS.has(labelNormalized)
}

export function isCleanupRenameAvailable(input: {
  userCreatedAt: string
  activeGlobalHandle: GlobalHandle
  now?: Date
}): boolean {
  if (input.activeGlobalHandle.free_rename_consumed) {
    return false
  }

  const createdAt = Date.parse(input.userCreatedAt)
  if (!Number.isFinite(createdAt)) {
    return false
  }

  return (input.now ?? new Date()).getTime() - createdAt <= FREE_CLEANUP_RENAME_WINDOW_MS
}

function desiredHandleTier(labelNormalized: string): HandleUpgradeQuote["tier"] {
  return labelNormalized.length >= 8 ? "standard" : "premium"
}

export function buildHandleUpgradeQuote(input: {
  desiredLabel: string
  labelNormalized: string
  currentActiveLabelNormalized: string
  cleanupRenameAvailable: boolean
  labelAvailable: boolean
}): HandleUpgradeQuote {
  const tier = desiredHandleTier(input.labelNormalized)

  if (input.labelNormalized === input.currentActiveLabelNormalized) {
    return {
      desired_label: input.desiredLabel,
      tier,
      price_usd: 0,
      eligible: false,
      reason: "Desired label is already active",
    }
  }

  if (isReservedGlobalHandleLabel(input.labelNormalized)) {
    return {
      desired_label: input.desiredLabel,
      tier,
      price_usd: 0,
      eligible: false,
      reason: "Desired label is reserved",
    }
  }

  if (!input.labelAvailable) {
    return {
      desired_label: input.desiredLabel,
      tier,
      price_usd: 0,
      eligible: false,
      reason: "Desired label is unavailable",
    }
  }

  if (input.labelNormalized.length >= 8) {
    return {
      desired_label: input.desiredLabel,
      tier: "standard",
      price_usd: input.cleanupRenameAvailable ? 0 : STANDARD_HANDLE_UPGRADE_PRICE_USD,
      eligible: true,
      reason: input.cleanupRenameAvailable ? "Eligible for free cleanup rename" : null,
    }
  }

  if (input.labelNormalized.length === 7) {
    return {
      desired_label: input.desiredLabel,
      tier: "premium",
      price_usd: PREMIUM_7_HANDLE_UPGRADE_PRICE_USD,
      eligible: true,
      reason: null,
    }
  }

  return {
    desired_label: input.desiredLabel,
    tier: "premium",
    price_usd: 0,
    eligible: false,
    reason: "Self-serve handles shorter than 7 characters are not available in v0",
  }
}

export function assertFreeCleanupRenameEligible(input: {
  desiredLabel: string
  labelNormalized: string
  activeGlobalHandle: GlobalHandle
  userCreatedAt: string
  now?: Date
}): void {
  if (input.labelNormalized === input.activeGlobalHandle.label.replace(/\.pirate$/i, "").toLowerCase()) {
    return
  }

  if (isReservedGlobalHandleLabel(input.labelNormalized)) {
    throw eligibilityFailed("Desired label is reserved")
  }

  if (!isCleanupRenameAvailable({
    userCreatedAt: input.userCreatedAt,
    activeGlobalHandle: input.activeGlobalHandle,
    now: input.now,
  })) {
    throw eligibilityFailed("Free cleanup rename is no longer available")
  }

  if (input.labelNormalized.length < 8) {
    throw eligibilityFailed("Free cleanup rename only applies to standard handles with 8 or more characters")
  }
}

export function assertRedditVerifiedClaimEligible(input: {
  labelNormalized: string
  verifiedRedditUsername?: string | null
}): void {
  const normalizedVerifiedUsername = String(input.verifiedRedditUsername || "").trim().replace(/^u\//i, "").toLowerCase()
  if (!normalizedVerifiedUsername || normalizedVerifiedUsername !== input.labelNormalized) {
    throw eligibilityFailed("Reddit verified claim is only allowed for your verified Reddit username")
  }
}
