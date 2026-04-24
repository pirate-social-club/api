import { eligibilityFailed } from "../errors"
import type { HandleUpgradeQuote, RedditImportSummary } from "../../types"

const REDDIT_STANDARD_HANDLE_MIN_LENGTH = 8
const REDDIT_MIN_CLAIM_LENGTH = 5
const PREMIUM_7_HANDLE_UPGRADE_PRICE_USD = 250

function requiredImportedRedditScore(labelLength: number): number | null {
  if (labelLength >= REDDIT_STANDARD_HANDLE_MIN_LENGTH) {
    return 0
  }
  if (labelLength === 7) {
    return 10_000
  }
  if (labelLength === 6) {
    return 50_000
  }
  if (labelLength === 5) {
    return 100_000
  }
  return null
}

function claimReason(labelLength: number, score: number): string {
  if (labelLength >= REDDIT_STANDARD_HANDLE_MIN_LENGTH) {
    return "Verified Reddit username claim"
  }
  const shorterBy = REDDIT_STANDARD_HANDLE_MIN_LENGTH - labelLength
  return `Verified Reddit username claim unlocked by ${score.toLocaleString("en-US")} imported Reddit score (${shorterBy} shorter character${shorterBy === 1 ? "" : "s"})`
}

export function buildRedditHandleClaimQuote(input: {
  desiredLabel: string
  labelNormalized: string
  currentActiveLabelNormalized: string
  labelAvailable: boolean
  verifiedRedditUsername: string | null
  latestImportSummary: RedditImportSummary | null
}): HandleUpgradeQuote {
  const tier: HandleUpgradeQuote["tier"] = input.labelNormalized.length >= REDDIT_STANDARD_HANDLE_MIN_LENGTH
    ? "standard"
    : "premium"
  const base = {
    desired_label: input.desiredLabel,
    tier,
    price_usd: 0,
    benefit_source: "verified_reddit_username" as const,
    reputation_discount_usd: input.labelNormalized.length === 7 ? PREMIUM_7_HANDLE_UPGRADE_PRICE_USD : 0,
  }

  if (input.labelNormalized === input.currentActiveLabelNormalized) {
    return {
      ...base,
      eligible: false,
      reason: "Desired label is already active",
      claim_reason: null,
    }
  }

  if (!input.verifiedRedditUsername || input.verifiedRedditUsername !== input.labelNormalized) {
    return {
      ...base,
      eligible: false,
      reason: "Desired label must match a verified Reddit username",
      claim_reason: null,
    }
  }

  if (!input.labelAvailable) {
    return {
      ...base,
      eligible: false,
      reason: "Desired label is unavailable",
      claim_reason: null,
    }
  }

  const importedScore = input.latestImportSummary?.imported_reddit_score
  if (typeof importedScore !== "number" || !Number.isFinite(importedScore)) {
    return {
      ...base,
      eligible: false,
      reason: "Reddit import is required",
      claim_reason: null,
    }
  }

  const requiredScore = requiredImportedRedditScore(input.labelNormalized.length)
  if (requiredScore == null) {
    return {
      ...base,
      eligible: false,
      reason: `Verified Reddit handle claims require ${REDDIT_MIN_CLAIM_LENGTH} or more characters`,
      claim_reason: null,
    }
  }

  if (importedScore < requiredScore) {
    return {
      ...base,
      eligible: false,
      reason: `Imported Reddit score must be at least ${requiredScore.toLocaleString("en-US")} for this handle length`,
      claim_reason: null,
    }
  }

  return {
    ...base,
    eligible: true,
    reason: "Eligible via verified Reddit reputation",
    claim_reason: claimReason(input.labelNormalized.length, importedScore),
  }
}

export function assertRedditHandleClaimEligible(quote: HandleUpgradeQuote): void {
  if (!quote.eligible) {
    throw eligibilityFailed(quote.reason ?? "Reddit handle claim is not available")
  }
}
