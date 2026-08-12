import type { CommunityHandleQuote, Env } from "../../../types"
import { unixSeconds } from "../../../serializers/time"
import { badRequestError, eligibilityFailed } from "../../errors"
import type { QueryResultRow } from "../../sql-client"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"
import {
  resolvePirateCheckoutOperatorAddress,
  resolvePirateCheckoutSourceChainId,
  resolvePirateCheckoutSourceChainName,
  resolvePirateCheckoutUsdcTokenAddress,
} from "../commerce/checkout-config"
import {
  type HandleClaimSettings,
  type HandlePricingModel,
  type NamespacePolicyRow,
  normalizeCommunityHandleLabel,
  withHandlePrefix,
} from "./handle-policy-service"

export type HandleAvailability =
  | "available"
  | "taken"
  | "reserved"
  | "already_claimed_by_viewer"
  | "viewer_has_claim"
  | "namespace_unavailable"

const DEFAULT_MIN_LABEL_LENGTH = 3
const DEFAULT_MAX_LABEL_LENGTH = 32
const DEFAULT_PREMIUM_MAX_LENGTH = 4
export const DEFAULT_HANDLE_QUOTE_TTL_SECONDS = 10 * 60
const RESERVED_LABELS = new Set([
  "admin",
  "administrator",
  "help",
  "mod",
  "moderator",
  "official",
  "owner",
  "security",
  "staff",
  "support",
])

export function addHandleQuoteSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString()
}

export function serializeHandleQuote(row: QueryResultRow, input: {
  env: Env
  eligible: boolean
  availability: HandleAvailability
  reason: string | null
  desiredLabel: string
  protocolIssuanceRequired?: boolean
  protocolIssuanceEligible?: boolean
  protocolIssuanceReason?: string | null
  claimGate?: CommunityHandleQuote["claim_gate"]
}): CommunityHandleQuote {
  const priceCents = requiredNumber(row, "price_cents")
  return {
    id: withHandlePrefix("hcq", requiredString(row, "handle_claim_quote_id")),
    object: "community_handle_quote",
    community: withHandlePrefix("com", requiredString(row, "community_id")),
    namespace: withHandlePrefix("ns", requiredString(row, "namespace_id")),
    desired_label: input.desiredLabel,
    label: requiredString(row, "label_display"),
    label_normalized: requiredString(row, "label_normalized"),
    eligible: input.eligible,
    availability: input.availability,
    reason: input.reason,
    claim_gate: input.claimGate ?? null,
    price_cents: priceCents,
    currency: "USD",
    pricing_model: stringOrNull(rowValue(row, "pricing_model")) as CommunityHandleQuote["pricing_model"],
    pricing_tier: stringOrNull(rowValue(row, "pricing_tier")),
    protocol_issuance_required: input.protocolIssuanceRequired === true,
    protocol_issuance_eligible: input.protocolIssuanceRequired === true
      ? input.protocolIssuanceEligible === true
      : true,
    protocol_issuance_reason: input.protocolIssuanceRequired === true
      ? input.protocolIssuanceReason ?? null
      : null,
    payment_instructions: input.eligible && priceCents > 0
      ? buildPaymentInstructions(input.env, priceCents)
      : null,
    quote_ttl_seconds: requiredNumber(row, "quote_ttl_seconds"),
    quoted_at: unixSeconds(requiredString(row, "quoted_at")),
    expires_at: unixSeconds(requiredString(row, "expires_at")),
  }
}

function buildPaymentInstructions(env: Env, priceCents: number): NonNullable<CommunityHandleQuote["payment_instructions"]> {
  const chainId = resolvePirateCheckoutSourceChainId(env)
  return {
    chain: {
      chain_namespace: "eip155",
      chain_id: chainId,
      display_name: resolvePirateCheckoutSourceChainName(chainId),
    },
    token_address: resolvePirateCheckoutUsdcTokenAddress(env),
    recipient_address: resolvePirateCheckoutOperatorAddress(env),
    amount_atomic: String(BigInt(priceCents) * 10_000n),
    amount_display: (priceCents / 100).toFixed(2),
  }
}

export function resolveHandlePrice(input: {
  labelNormalized: string
  policy: NamespacePolicyRow
  settings: HandleClaimSettings
}): {
  priceCents: number
  pricingModel: HandlePricingModel | null
  pricingTier: string | null
} {
  const pricingModel = input.policy.pricing_model ?? (
    input.settings.flat_price_cents == null ? "free" : "flat_by_length"
  )
  if (pricingModel === "custom_curve") {
    throw eligibilityFailed("Custom handle pricing is not available yet")
  }
  if (pricingModel === "free") {
    return { priceCents: 0, pricingModel, pricingTier: "free" }
  }
  const specialPriceCents = input.settings.special_price_cents_by_label?.[input.labelNormalized]
  if (specialPriceCents != null) {
    return { priceCents: specialPriceCents, pricingModel, pricingTier: "special" }
  }
  const premiumMaxLength = input.settings.premium_max_length ?? DEFAULT_PREMIUM_MAX_LENGTH
  const isPremium = input.policy.policy_template === "premium" && input.labelNormalized.length <= premiumMaxLength
  const priceCents = isPremium
    ? input.settings.premium_price_cents ?? input.settings.flat_price_cents ?? 0
    : input.settings.flat_price_cents ?? 0
  return {
    priceCents,
    pricingModel,
    pricingTier: isPremium ? "premium" : "standard",
  }
}

export function assertHandleLabelLength(labelNormalized: string, settings: HandleClaimSettings): void {
  const minLength = settings.min_length ?? DEFAULT_MIN_LABEL_LENGTH
  const maxLength = settings.max_length ?? DEFAULT_MAX_LABEL_LENGTH
  if (labelNormalized.length < minLength) {
    throw badRequestError(`desired_label must be at least ${minLength} characters`)
  }
  if (labelNormalized.length > maxLength) {
    throw badRequestError(`desired_label must be at most ${maxLength} characters`)
  }
}

export function isReservedHandleLabel(labelNormalized: string, settings: HandleClaimSettings): boolean {
  if (RESERVED_LABELS.has(labelNormalized)) {
    return true
  }
  return new Set(
    (settings.reserved_labels ?? []).map((label) => normalizeCommunityHandleLabel(label).labelNormalized),
  ).has(labelNormalized)
}

export function handleAvailabilityDetails(
  availability: HandleAvailability,
  reason: string,
): Record<string, unknown> {
  return { availability, reason }
}
