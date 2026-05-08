import { badRequestError, eligibilityFailed } from "../errors"
import type { GlobalHandle, HandleUpgradeQuote } from "../../types"
import { GLOBAL_HANDLE_PREMIUM_TERMS, GLOBAL_HANDLE_RESERVED_TERMS } from "./global-handle-premium-terms"

const GLOBAL_HANDLE_SUFFIX = ".pirate"
const FREE_CLEANUP_RENAME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const GLOBAL_HANDLE_PAID_POLICY_VERSION = "global_handle_paid_v1"
const MANUAL_SALE_THRESHOLD_CENTS = 25_000 * 100
const PREMIUM_TERMS_BY_LABEL = new Map(GLOBAL_HANDLE_PREMIUM_TERMS.map((term) => [term.term, term]))
const PRICE_BANDS_CENTS = [
  5,
  10,
  15,
  25,
  50,
  100,
  150,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  25_000,
].map((price) => price * 100)

function normalizeLabelWithIdna(label: string): string {
  if (/^[\x00-\x7F]+$/u.test(label)) {
    return label
  }
  try {
    return new URL(`https://${label}${GLOBAL_HANDLE_SUFFIX}`).hostname.split(".")[0] ?? label
  } catch {
    throw badRequestError("Invalid desired_label")
  }
}

export function normalizeDesiredGlobalHandleLabel(desiredLabel: string): {
  labelNormalized: string
  labelDisplay: string
} {
  const trimmed = desiredLabel.trim().toLowerCase()
  const withoutSuffix = trimmed.endsWith(GLOBAL_HANDLE_SUFFIX)
    ? trimmed.slice(0, -GLOBAL_HANDLE_SUFFIX.length)
    : trimmed
  const labelNormalized = normalizeLabelWithIdna(withoutSuffix)

  const isAsciiLabel = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(labelNormalized)
  const isPunycodeLabel = /^xn--[a-z0-9-]+$/u.test(labelNormalized)
  if (!labelNormalized || (!isAsciiLabel && !isPunycodeLabel)) {
    throw badRequestError("Invalid desired_label")
  }

  return {
    labelNormalized,
    labelDisplay: `${labelNormalized}${GLOBAL_HANDLE_SUFFIX}`,
  }
}

export function isReservedGlobalHandleLabel(labelNormalized: string): boolean {
  return GLOBAL_HANDLE_RESERVED_TERMS.has(labelNormalized)
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

function basePriceCentsForLength(labelLength: number): number | null {
  if (labelLength >= 8) return 5 * 100
  if (labelLength === 7) return 10 * 100
  if (labelLength === 6) return 25 * 100
  if (labelLength === 5) return 50 * 100
  if (labelLength === 4) return 100 * 100
  if (labelLength === 3) return 250 * 100
  return null
}

function discountMultiplierForLabel(labelNormalized: string): number {
  const hasHyphen = labelNormalized.includes("-")
  const hasNumber = /\d/u.test(labelNormalized)
  if (hasHyphen && hasNumber) return 0.5
  if (hasHyphen) return 0.7
  if (hasNumber) return 0.8
  return 1
}

function roundToPriceBand(priceCents: number): number {
  return PRICE_BANDS_CENTS.reduce((best, candidate) => {
    return Math.abs(candidate - priceCents) < Math.abs(best - priceCents) ? candidate : best
  }, PRICE_BANDS_CENTS[0])
}

export function resolveGlobalHandlePaidPrice(input: {
  labelNormalized: string
}): {
  eligible: boolean
  priceCents: number
  pricingTier: string
  reason: string | null
  policyVersion: typeof GLOBAL_HANDLE_PAID_POLICY_VERSION
} {
  if (isReservedGlobalHandleLabel(input.labelNormalized)) {
    return {
      eligible: false,
      priceCents: 0,
      pricingTier: "reserved",
      reason: "Desired label is reserved",
      policyVersion: GLOBAL_HANDLE_PAID_POLICY_VERSION,
    }
  }

  const basePriceCents = basePriceCentsForLength(input.labelNormalized.length)
  if (basePriceCents == null) {
    return {
      eligible: false,
      priceCents: 0,
      pricingTier: "reserved_short",
      reason: "Self-serve handles shorter than 3 characters are not available",
      policyVersion: GLOBAL_HANDLE_PAID_POLICY_VERSION,
    }
  }

  const premiumTerm = PREMIUM_TERMS_BY_LABEL.get(input.labelNormalized)
  const premiumMultiplier = premiumTerm?.multiplier ?? 1
  const discountMultiplier = discountMultiplierForLabel(input.labelNormalized)
  const rawPriceCents = Math.round(basePriceCents * premiumMultiplier * discountMultiplier)
  if (rawPriceCents >= MANUAL_SALE_THRESHOLD_CENTS && premiumMultiplier > 1) {
    return {
      eligible: false,
      priceCents: 0,
      pricingTier: "manual_sale",
      reason: "Manual sale only",
      policyVersion: GLOBAL_HANDLE_PAID_POLICY_VERSION,
    }
  }

  return {
    eligible: true,
    priceCents: roundToPriceBand(rawPriceCents),
    pricingTier: premiumTerm ? premiumTerm.type : discountMultiplier < 1 ? "discounted" : "base",
    reason: null,
    policyVersion: GLOBAL_HANDLE_PAID_POLICY_VERSION,
  }
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
      price_cents: 0,
      eligible: false,
      reason: "Desired label is already active",
    }
  }

  const paidPrice = resolveGlobalHandlePaidPrice({
    labelNormalized: input.labelNormalized,
  })
  if (!paidPrice.eligible) {
    return {
      desired_label: input.desiredLabel,
      tier,
      price_cents: 0,
      eligible: false,
      reason: paidPrice.reason,
      policy_version: paidPrice.policyVersion,
      pricing_tier: paidPrice.pricingTier,
    }
  }

  if (!input.labelAvailable) {
    return {
      desired_label: input.desiredLabel,
      tier,
      price_cents: 0,
      eligible: false,
      reason: "Desired label is unavailable",
    }
  }

  if (input.labelNormalized.length >= 8) {
    const cleanupEligible = input.cleanupRenameAvailable
      && (paidPrice.pricingTier === "base" || paidPrice.pricingTier === "discounted")
    return {
      desired_label: input.desiredLabel,
      tier: "standard",
      price_cents: cleanupEligible ? 0 : paidPrice.priceCents,
      eligible: true,
      reason: cleanupEligible ? "Eligible for free cleanup rename" : null,
      policy_version: paidPrice.policyVersion,
      pricing_tier: paidPrice.pricingTier,
    }
  }

  return {
    desired_label: input.desiredLabel,
    tier: "premium",
    price_cents: paidPrice.priceCents,
    eligible: true,
    reason: null,
    policy_version: paidPrice.policyVersion,
    pricing_tier: paidPrice.pricingTier,
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
