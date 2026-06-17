import type {
  CommunityHandle,
  CommunityHandleClaimRequest,
  CommunityHandleListResponse,
  CommunityHandleMeResponse,
  CommunityHandlePolicy,
  CommunityHandlePolicySettings,
  CommunityHandleQuote,
  CommunityHandleQuoteRequest,
  CommunityHandleReserveRequest,
  CommunityHandleRevokeRequest,
  CommunityHandleProtocolIssuance,
  CommunityHandleStatusResponse,
  Env,
  UpdateCommunityHandlePolicyRequest,
} from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { HttpError, conflictError, badRequestError, eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import type { Client, QueryResultRow, Transaction } from "../../sql-client"
import { numberOrNull, requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"
import { nullableUnixSeconds, unixSeconds } from "../../../serializers/time"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityDatabaseBindingRepository, CommunityReadRepository } from "../db-community-repository"
import { requireCommunityOwner } from "../commerce/access"
import { canAccessCommunity, getCommunityMembershipState } from "../membership/membership-state-store"
import {
  resolvePirateCheckoutOperatorAddress,
  resolvePirateCheckoutSourceChainId,
  resolvePirateCheckoutSourceChainName,
  resolvePirateCheckoutUsdcTokenAddress,
} from "../commerce/checkout-config"
import { verifyPirateCheckoutUsdcFunding } from "../commerce/funding-proof-service"
import { getCommunityMoneyPolicy } from "../commerce/policy-service"
import { parseBitcoinAddress, type ParsedBitcoinAddress } from "../../bitcoin/bitcoin-address"
import type { WalletAttachmentRecord } from "../../auth/repositories"

type HandlePricingModel = NonNullable<CommunityHandleQuote["pricing_model"]>
type HandleCommunityRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

type NamespacePolicyRow = {
  namespace_handle_policy_id: string
  community_id: string
  namespace_id: string
  display_label: string
  normalized_label: string
  route_family: string | null
  policy_template: CommunityHandlePolicy["policy_template"]
  pricing_model: HandlePricingModel | null
  claims_enabled: boolean
  settings_json: string | null
  updated_at: string | null
}

type HandleClaimSettings = {
  flat_price_cents?: number
  premium_price_cents?: number
  premium_max_length?: number
  min_length?: number
  max_length?: number
  quote_ttl_seconds?: number
  reserved_labels?: string[]
  special_price_cents_by_label?: Record<string, number>
  issuance_mode?: "app_internal" | "spaces_subspace"
}

type Availability =
  | "available"
  | "taken"
  | "reserved"
  | "already_claimed_by_viewer"
  | "viewer_has_claim"
  | "namespace_unavailable"

const DEFAULT_MIN_LABEL_LENGTH = 3
const DEFAULT_MAX_LABEL_LENGTH = 32
const DEFAULT_PREMIUM_MAX_LENGTH = 4
const DEFAULT_HANDLE_QUOTE_TTL_SECONDS = 10 * 60
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

export function normalizeCommunityHandleLabel(desiredLabel: unknown): {
  labelNormalized: string
  labelDisplay: string
} {
  if (typeof desiredLabel !== "string") {
    throw badRequestError("Invalid desired_label")
  }
  const trimmed = desiredLabel.trim().toLowerCase()
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed
  const withoutSuffix = withoutAt.includes("@") ? withoutAt.slice(0, withoutAt.indexOf("@")) : withoutAt

  const isAsciiLabel = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(withoutSuffix)
  const isPunycodeLabel = /^xn--[a-z0-9-]+$/u.test(withoutSuffix)
  if (!withoutSuffix || (!isAsciiLabel && !isPunycodeLabel)) {
    throw badRequestError("Invalid desired_label")
  }

  return {
    labelNormalized: withoutSuffix,
    labelDisplay: withoutSuffix,
  }
}

function parseSettings(raw: string | null): HandleClaimSettings {
  if (!raw?.trim()) {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      flat_price_cents: finiteNonNegativeInteger(parsed.flat_price_cents),
      premium_price_cents: finiteNonNegativeInteger(parsed.premium_price_cents),
      premium_max_length: finitePositiveInteger(parsed.premium_max_length),
      min_length: finitePositiveInteger(parsed.min_length),
      max_length: finitePositiveInteger(parsed.max_length),
      quote_ttl_seconds: finitePositiveInteger(parsed.quote_ttl_seconds),
      issuance_mode: parsed.issuance_mode === "spaces_subspace" ? "spaces_subspace" : undefined,
      reserved_labels: Array.isArray(parsed.reserved_labels)
        ? parsed.reserved_labels.filter((value): value is string => typeof value === "string")
        : undefined,
      special_price_cents_by_label: parseSpecialPrices(parsed.special_price_cents_by_label),
    }
  } catch {
    throw internalError("Community handle policy settings are malformed", {
      reason: "invalid_settings_json",
    })
  }
}

function parseSpecialPrices(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const entries = Object.entries(value)
    .map(([label, price]) => {
      const parsedPrice = finiteNonNegativeInteger(price)
      if (parsedPrice == null) return null
      return [normalizeCommunityHandleLabel(label).labelNormalized, parsedPrice] as const
    })
    .filter((entry): entry is readonly [string, number] => entry != null)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined
}

function finitePositiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString()
}

function withPrefix(prefix: string, value: string): string {
  return value.startsWith(`${prefix}_`) ? value : `${prefix}_${value}`
}

function normalizeSubmittedPrefixedId(prefix: string, value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith(`${prefix}_${prefix}_`) ? trimmed.slice(prefix.length + 1) : trimmed
}

const HANDLE_PROTOCOL_ISSUANCE_SELECT = `
  ch.*,
  hpi.public_status AS protocol_issuance_status,
  hpi.sname AS protocol_issuance_sname,
  hpi.parent_space AS protocol_issuance_parent_space,
  hpi.issued_at AS protocol_issuance_issued_at
`

const HANDLE_PROTOCOL_ISSUANCE_JOIN = `
  LEFT JOIN community_handle_protocol_issuances hpi
    ON hpi.community_handle_id = ch.community_handle_id
`

function parentSpaceFromNamespaceLabel(normalizedLabel: string): string {
  const bareLabel = normalizedLabel.startsWith("@") ? normalizedLabel.slice(1) : normalizedLabel
  return `@${bareLabel}`
}

function protocolSnameForHandle(labelNormalized: string, parentSpace: string): string {
  return `${labelNormalized}@${parentSpace.startsWith("@") ? parentSpace.slice(1) : parentSpace}`
}

function serializePolicy(row: NamespacePolicyRow): CommunityHandlePolicy {
  return {
    id: withPrefix("nhp", row.namespace_handle_policy_id),
    object: "community_handle_policy",
    community: withPrefix("com", row.community_id),
    namespace: withPrefix("ns", row.namespace_id),
    policy_template: row.policy_template,
    pricing_model: row.pricing_model,
    claims_enabled: row.claims_enabled,
    settings: parseSettings(row.settings_json),
    updated_at: nullableUnixSeconds(row.updated_at),
  }
}

function serializeProtocolIssuance(row: QueryResultRow): CommunityHandleProtocolIssuance | null {
  const status = stringOrNull(rowValue(row, "protocol_issuance_status"))
  if (!status) {
    return null
  }
  return {
    status,
    sname: requiredString(row, "protocol_issuance_sname"),
    parent_space: requiredString(row, "protocol_issuance_parent_space"),
    issued_at: nullableUnixSeconds(stringOrNull(rowValue(row, "protocol_issuance_issued_at"))),
  }
}

function serializeHandle(row: QueryResultRow): CommunityHandle {
  const protocolIssuance = serializeProtocolIssuance(row)
  return {
    id: withPrefix("ch", requiredString(row, "community_handle_id")),
    object: "community_handle",
    community: withPrefix("com", requiredString(row, "community_id")),
    namespace: withPrefix("ns", requiredString(row, "namespace_id")),
    user: withPrefix("usr", requiredString(row, "user_id")),
    label: requiredString(row, "label_display"),
    label_normalized: requiredString(row, "label_normalized"),
    status: requiredString(row, "status") as CommunityHandle["status"],
    issuance_source: requiredString(row, "issuance_source") as CommunityHandle["issuance_source"],
    quote: stringOrNull(rowValue(row, "handle_claim_quote_id"))
      ? withPrefix("hcq", String(stringOrNull(rowValue(row, "handle_claim_quote_id"))))
      : null,
    price_cents: requiredNumber(row, "price_cents"),
    currency: "USD",
    pricing_model: stringOrNull(rowValue(row, "pricing_model")) as CommunityHandle["pricing_model"],
    pricing_tier: stringOrNull(rowValue(row, "pricing_tier")),
    settlement_wallet_attachment: stringOrNull(rowValue(row, "settlement_wallet_attachment_id")),
    protocol_owner_wallet_attachment: stringOrNull(rowValue(row, "protocol_owner_wallet_attachment_id")),
    funding_tx_ref: stringOrNull(rowValue(row, "funding_tx_ref")),
    settlement_tx_ref: stringOrNull(rowValue(row, "settlement_tx_ref")),
    lease_started_at: nullableUnixSeconds(stringOrNull(rowValue(row, "lease_started_at"))),
    lease_expires_at: nullableUnixSeconds(stringOrNull(rowValue(row, "lease_expires_at"))),
    ...(protocolIssuance ? { protocol_issuance: protocolIssuance } : {}),
    created: unixSeconds(requiredString(row, "created_at")),
  }
}

function protocolIssuanceRequired(settings: HandleClaimSettings): boolean {
  return settings.issuance_mode === "spaces_subspace"
}

function namespaceSupportsSpacesSubspace(policy: Pick<NamespacePolicyRow, "display_label" | "normalized_label" | "route_family">): boolean {
  return policy.route_family === "spaces"
    || policy.display_label.startsWith("@")
    || policy.normalized_label.startsWith("@")
}

function requireProtocolIssuanceSupport(
  policy: Pick<NamespacePolicyRow, "display_label" | "normalized_label" | "route_family">,
  settings: HandleClaimSettings,
): boolean {
  if (!protocolIssuanceRequired(settings)) {
    return false
  }
  if (!namespaceSupportsSpacesSubspace(policy)) {
    throw eligibilityFailed("Protocol-issued names require a Spaces namespace")
  }
  return true
}

function findTaprootProtocolOwnerWallet(
  wallets: Array<Pick<WalletAttachmentRecord, "chain_namespace" | "wallet_address" | "wallet_attachment">>,
): { wallet: Pick<WalletAttachmentRecord, "chain_namespace" | "wallet_address" | "wallet_attachment">; parsed: ParsedBitcoinAddress } | null {
  for (const wallet of wallets) {
    if (!wallet.chain_namespace.startsWith("bip122:")) {
      continue
    }
    const parsed = parseBitcoinAddress(wallet.wallet_address)
    if (parsed?.kind === "p2tr") {
      return { wallet, parsed }
    }
  }
  return null
}

async function requireProtocolOwnerWalletForClaim(input: {
  body: CommunityHandleClaimRequest
  userId: string
  userRepository: UserRepository
}): Promise<{ walletAttachmentId: string; scriptPubkeyHex: string }> {
  const submittedWalletAttachment = input.body.protocol_owner_wallet_attachment?.trim()
  if (!submittedWalletAttachment) {
    throw new HttpError(400, "bad_request", "protocol_owner_wallet_attachment is required for protocol-issued names", false, {
      protocol_owner_wallet_attachment: "missing",
    })
  }

  const wallet = await input.userRepository.getWalletAttachmentById(submittedWalletAttachment)
  if (!wallet) {
    throw notFoundError("protocol_owner_wallet_attachment was not found")
  }
  if (wallet.user_id !== input.userId) {
    throw eligibilityFailed("protocol_owner_wallet_attachment belongs to a different user", {
      protocol_owner_wallet_attachment: "wrong_user",
    })
  }
  if (wallet.status !== "active") {
    throw eligibilityFailed("protocol_owner_wallet_attachment is not active", {
      protocol_owner_wallet_attachment: "not_active",
    })
  }
  if (!wallet.chain_namespace.startsWith("bip122:")) {
    throw eligibilityFailed("protocol_owner_wallet_attachment must be a Bitcoin wallet", {
      protocol_owner_wallet_attachment: "wrong_chain",
      chain_namespace: wallet.chain_namespace,
    })
  }

  const parsed = parseBitcoinAddress(wallet.wallet_address)
  if (!parsed) {
    throw eligibilityFailed("protocol_owner_wallet_attachment has an invalid Bitcoin address", {
      protocol_owner_wallet_attachment: "invalid_bitcoin_address",
    })
  }
  if (parsed.kind !== "p2tr") {
    throw eligibilityFailed("protocol_owner_wallet_attachment must be a Bitcoin Taproot wallet", {
      protocol_owner_wallet_attachment: "not_taproot",
      bitcoin_address_kind: parsed.kind,
    })
  }

  return {
    walletAttachmentId: wallet.wallet_attachment,
    scriptPubkeyHex: parsed.scriptPubkeyHex,
  }
}

function serializeQuote(row: QueryResultRow, input: {
  env: Env
  eligible: boolean
  availability: Availability
  reason: string | null
  desiredLabel: string
  protocolIssuanceRequired?: boolean
  protocolIssuanceEligible?: boolean
  protocolIssuanceReason?: string | null
}): CommunityHandleQuote {
  const priceCents = requiredNumber(row, "price_cents")
  return {
    id: withPrefix("hcq", requiredString(row, "handle_claim_quote_id")),
    object: "community_handle_quote",
    community: withPrefix("com", requiredString(row, "community_id")),
    namespace: withPrefix("ns", requiredString(row, "namespace_id")),
    desired_label: input.desiredLabel,
    label: requiredString(row, "label_display"),
    label_normalized: requiredString(row, "label_normalized"),
    eligible: input.eligible,
    availability: input.availability,
    reason: input.reason,
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

async function expireStaleHandleQuotes(input: {
  executor: Client | Transaction
  communityId: string
  userId?: string | null
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE community_handle_claim_quotes
      SET status = 'expired',
          updated_at = ?2
      WHERE community_id = ?1
        AND status = 'quoted'
        AND expires_at <= ?2
        AND (?3 IS NULL OR user_id = ?3)
    `,
    args: [input.communityId, input.now, input.userId ?? null],
  })
}

async function getNamespacePolicy(executor: Client | Transaction, communityId: string): Promise<NamespacePolicyRow | null> {
  const result = await executor.execute({
    sql: `
      SELECT nb.community_id, nb.namespace_id, nb.display_label, nb.normalized_label, nb.route_family,
             nhp.namespace_handle_policy_id, nhp.policy_template, nhp.pricing_model,
             nhp.claims_enabled, nhp.settings_json, nhp.updated_at
      FROM namespace_bindings nb
      LEFT JOIN namespace_handle_policies nhp
        ON nhp.namespace_id = nb.namespace_id
      WHERE nb.community_id = ?1
        AND nb.status = 'active'
      LIMIT 1
    `,
    args: [communityId],
  })
  const row = result.rows[0]
  if (!row) return null
  return {
    namespace_handle_policy_id: stringOrNull(rowValue(row, "namespace_handle_policy_id")) ?? `nhp_${communityId}`,
    community_id: requiredString(row, "community_id"),
    namespace_id: requiredString(row, "namespace_id"),
    display_label: requiredString(row, "display_label"),
    normalized_label: requiredString(row, "normalized_label"),
    route_family: stringOrNull(rowValue(row, "route_family")),
    policy_template: (stringOrNull(rowValue(row, "policy_template")) ?? "standard") as CommunityHandlePolicy["policy_template"],
    pricing_model: stringOrNull(rowValue(row, "pricing_model")) as HandlePricingModel | null,
    claims_enabled: numberOrNull(rowValue(row, "claims_enabled")) !== 0,
    settings_json: stringOrNull(rowValue(row, "settings_json")),
    updated_at: stringOrNull(rowValue(row, "updated_at")),
  }
}

async function getBlockingHandleForLabel(
  executor: Client | Transaction,
  namespaceId: string,
  labelNormalized: string,
): Promise<QueryResultRow | null> {
  const result = await executor.execute({
    sql: `
      SELECT *
      FROM community_handles
      WHERE namespace_id = ?1
        AND label_normalized = ?2
        AND status IN ('active', 'reserved')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END
      LIMIT 1
    `,
    args: [namespaceId, labelNormalized],
  })
  return result.rows[0] ?? null
}

async function getActiveHandleForUser(
  executor: Client | Transaction,
  namespaceId: string,
  userId: string,
): Promise<QueryResultRow | null> {
  const result = await executor.execute({
    sql: `
      SELECT ${HANDLE_PROTOCOL_ISSUANCE_SELECT}
      FROM community_handles ch
      ${HANDLE_PROTOCOL_ISSUANCE_JOIN}
      WHERE ch.namespace_id = ?1
        AND ch.user_id = ?2
        AND ch.status = 'active'
      LIMIT 1
    `,
    args: [namespaceId, userId],
  })
  return result.rows[0] ?? null
}

function resolvePrice(input: {
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

function assertLabelLength(labelNormalized: string, settings: HandleClaimSettings): void {
  const minLength = settings.min_length ?? DEFAULT_MIN_LABEL_LENGTH
  const maxLength = settings.max_length ?? DEFAULT_MAX_LABEL_LENGTH
  if (labelNormalized.length < minLength) {
    throw badRequestError(`desired_label must be at least ${minLength} characters`)
  }
  if (labelNormalized.length > maxLength) {
    throw badRequestError(`desired_label must be at most ${maxLength} characters`)
  }
}

function isReservedLabel(labelNormalized: string, settings: HandleClaimSettings): boolean {
  if (RESERVED_LABELS.has(labelNormalized)) {
    return true
  }
  return new Set((settings.reserved_labels ?? []).map((label) => normalizeCommunityHandleLabel(label).labelNormalized)).has(labelNormalized)
}

function availabilityDetails(availability: Availability, reason: string): Record<string, unknown> {
  return { availability, reason }
}

function assertPolicyTemplate(value: unknown): CommunityHandlePolicy["policy_template"] {
  if (value === "standard" || value === "premium" || value === "membership_gated" || value === "custom") {
    return value
  }
  throw badRequestError("Invalid policy_template")
}

function assertPricingModel(value: unknown): HandlePricingModel | null {
  if (value == null) return null
  if (value === "free" || value === "flat_by_length" || value === "custom_curve" || value === "gated_then_flat") {
    return value
  }
  throw badRequestError("Invalid pricing_model")
}

function optionalIntegerSetting(
  value: unknown,
  key: keyof CommunityHandlePolicySettings,
  options: { min: number },
): number | undefined {
  if (value == null) return undefined
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(numeric) || numeric < options.min) {
    throw badRequestError(`${String(key)} must be an integer >= ${options.min}`)
  }
  return numeric
}

function optionalIssuanceModeSetting(value: unknown): HandleClaimSettings["issuance_mode"] {
  if (value == null || value === "app_internal") return undefined
  if (value === "spaces_subspace") return "spaces_subspace"
  throw badRequestError("issuance_mode must be app_internal or spaces_subspace")
}

function sanitizeSettings(input: CommunityHandlePolicySettings | null | undefined): HandleClaimSettings {
  if (!input) return {}
  const settings: HandleClaimSettings = {
    flat_price_cents: optionalIntegerSetting(input.flat_price_cents, "flat_price_cents", { min: 0 }),
    premium_price_cents: optionalIntegerSetting(input.premium_price_cents, "premium_price_cents", { min: 0 }),
    premium_max_length: optionalIntegerSetting(input.premium_max_length, "premium_max_length", { min: 1 }),
    min_length: optionalIntegerSetting(input.min_length, "min_length", { min: 1 }),
    max_length: optionalIntegerSetting(input.max_length, "max_length", { min: 1 }),
    quote_ttl_seconds: optionalIntegerSetting(input.quote_ttl_seconds, "quote_ttl_seconds", { min: 60 }),
    issuance_mode: optionalIssuanceModeSetting(input.issuance_mode),
    reserved_labels: Array.isArray(input.reserved_labels)
      ? input.reserved_labels.map((label) => normalizeCommunityHandleLabel(label).labelNormalized)
      : undefined,
    special_price_cents_by_label: parseSpecialPrices(input.special_price_cents_by_label),
  }
  if (
    settings.min_length != null
    && settings.max_length != null
    && settings.min_length > settings.max_length
  ) {
    throw badRequestError("min_length must be <= max_length")
  }
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as HandleClaimSettings
}

async function requireClaimAccess(input: {
  client: Client | Transaction
  communityId: string
  userId: string
}): Promise<{ isMember: boolean }> {
  const membership = await getCommunityMembershipState(input.client as Client, input.communityId, input.userId)
  const isMember = canAccessCommunity(membership)
  if (isMember) {
    return { isMember }
  }
  throw eligibilityFailed("Community membership is required to claim names")
}

export async function getMyCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandleMeResponse> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const policy = await getNamespacePolicy(db.client, input.communityId)
    if (!policy) {
      return { handle: null }
    }
    const handle = await getActiveHandleForUser(db.client, policy.namespace_id, input.userId)
    return { handle: handle ? serializeHandle(handle) : null }
  } finally {
    db.close()
  }
}

export async function getCommunityHandleStatus(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandleStatusResponse> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const policy = await getNamespacePolicy(db.client, input.communityId)
    if (!policy) {
      return {
        available: false,
        reason: "Community names are not available for this community",
        claims_enabled: null,
        namespace: null,
      }
    }
    if (!policy.claims_enabled) {
      return {
        available: false,
        reason: "Community name claims are currently disabled",
        claims_enabled: false,
        namespace: withPrefix("ns", policy.namespace_id),
      }
    }
    const access = await requireClaimAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    }).catch((error: unknown) => {
      if (error instanceof HttpError && error.code === "eligibility_failed") {
        return { blockedReason: error.message }
      }
      throw error
    })
    if ("blockedReason" in access) {
      return {
        available: false,
        reason: access.blockedReason,
        claims_enabled: true,
        namespace: withPrefix("ns", policy.namespace_id),
      }
    }
    return {
      available: true,
      reason: null,
      claims_enabled: true,
      namespace: withPrefix("ns", policy.namespace_id),
    }
  } finally {
    db.close()
  }
}

export async function getCommunityHandlePolicy(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandlePolicy> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const policy = await getNamespacePolicy(db.client, input.communityId)
    if (!policy) {
      throw eligibilityFailed("Community names are not available for this community")
    }
    return serializePolicy(policy)
  } finally {
    db.close()
  }
}

export async function updateCommunityHandlePolicy(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityHandlePolicyRequest
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandlePolicy> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const current = await getNamespacePolicy(db.client, input.communityId)
    if (!current) {
      throw eligibilityFailed("Community names are not available for this community")
    }
    const nextSettings = "settings" in input.body
      ? sanitizeSettings(input.body.settings ?? null)
      : parseSettings(current.settings_json)
    if (protocolIssuanceRequired(nextSettings) && !namespaceSupportsSpacesSubspace(current)) {
      throw badRequestError("spaces_subspace issuance requires a Spaces namespace")
    }
    const updatedAt = nowIso()
    await db.client.execute({
      sql: `
        INSERT INTO namespace_handle_policies (
          namespace_handle_policy_id, community_id, namespace_id, policy_template, pricing_model,
          membership_required_for_claim, claims_enabled, settings_json, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9
        )
        ON CONFLICT(namespace_handle_policy_id) DO UPDATE SET
          policy_template = excluded.policy_template,
          pricing_model = excluded.pricing_model,
          membership_required_for_claim = excluded.membership_required_for_claim,
          claims_enabled = excluded.claims_enabled,
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `,
      args: [
        current.namespace_handle_policy_id,
        input.communityId,
        current.namespace_id,
        "policy_template" in input.body
          ? assertPolicyTemplate(input.body.policy_template)
          : current.policy_template,
        "pricing_model" in input.body
          ? assertPricingModel(input.body.pricing_model)
          : current.pricing_model,
        1,
        "claims_enabled" in input.body
          ? input.body.claims_enabled === true ? 1 : 0
          : current.claims_enabled ? 1 : 0,
        JSON.stringify(nextSettings),
        updatedAt,
      ],
    })
    const updated = await getNamespacePolicy(db.client, input.communityId)
    if (!updated) {
      throw internalError("Updated community handle policy row is missing")
    }
    return serializePolicy(updated)
  } finally {
    db.close()
  }
}

export async function listCommunityHandles(input: {
  env: Env
  userId: string
  communityId: string
  status?: string | null
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandleListResponse> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const policy = await getNamespacePolicy(db.client, input.communityId)
    if (!policy) {
      throw eligibilityFailed("Community names are not available for this community")
    }
    const status = input.status?.trim()
    const allowedStatuses = new Set(["active", "grace_period", "expired", "revoked", "reserved"])
    if (status && !allowedStatuses.has(status)) {
      throw badRequestError("Invalid handle status")
    }
    const result = await db.client.execute({
      sql: `
        SELECT ${HANDLE_PROTOCOL_ISSUANCE_SELECT}
        FROM community_handles ch
        ${HANDLE_PROTOCOL_ISSUANCE_JOIN}
        WHERE ch.community_id = ?1
          AND ch.namespace_id = ?2
          AND (?3 IS NULL OR ch.status = ?3)
        ORDER BY ch.created_at DESC
        LIMIT 200
      `,
      args: [input.communityId, policy.namespace_id, status || null],
    })
    return { handles: result.rows.map(serializeHandle) }
  } finally {
    db.close()
  }
}

export async function reserveCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityHandleReserveRequest
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandle> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const desired = normalizeCommunityHandleLabel(input.body.desired_label)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    return serializeHandle(await reserveCommunityHandleOnClient(db.client, {
      communityId: input.communityId,
      userId: input.userId,
      desired,
    }))
  } finally {
    db.close()
  }
}

/**
 * Buffer-safe reservation. The namespace policy + blocking-handle reads and all
 * validation run on the base client BEFORE the write tx (a buffered D1 write tx
 * can't read them back mid-flight); the tx body is a single INSERT guarded by the
 * namespace/label unique constraint (the real concurrency protection); the created
 * row is read back AFTER commit. Returns the raw handle row. Exported for buffer tests.
 */
export async function reserveCommunityHandleOnClient(
  client: Client,
  input: { communityId: string; userId: string; desired: { labelNormalized: string; labelDisplay: string } },
): Promise<QueryResultRow> {
  const policy = await getNamespacePolicy(client, input.communityId)
  if (!policy) {
    throw eligibilityFailed("Community names are not available for this community")
  }
  const settings = parseSettings(policy.settings_json)
  assertLabelLength(input.desired.labelNormalized, settings)
  if (isReservedLabel(input.desired.labelNormalized, settings)) {
    const reason = "Desired label is already reserved"
    throw conflictError(reason, availabilityDetails("reserved", reason))
  }
  const blockingHandle = await getBlockingHandleForLabel(client, policy.namespace_id, input.desired.labelNormalized)
  if (blockingHandle) {
    const status = requiredString(blockingHandle, "status")
    const reason = status === "reserved"
      ? "Desired label is already reserved"
      : "Desired label is unavailable"
    throw conflictError(reason, availabilityDetails(status === "reserved" ? "reserved" : "taken", reason))
  }

  const now = nowIso()
  const handleId = makeId("ch")
  const tx = await client.transaction("write")
  try {
    await tx.execute({
      sql: `
        INSERT INTO community_handles (
          community_handle_id, community_id, user_id, namespace_id, handle_claim_quote_id,
          label_normalized, label_display, status, issuance_source, price_cents, currency,
          pricing_model, pricing_tier, settlement_wallet_attachment_id, funding_tx_ref, settlement_tx_ref,
          lease_started_at, lease_expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, NULL,
          ?5, ?6, 'reserved', 'admin_grant', 0, 'USD',
          NULL, 'reserved', NULL, NULL, NULL,
          NULL, NULL, ?7, ?7
        )
      `,
      args: [
        handleId,
        input.communityId,
        input.userId,
        policy.namespace_id,
        input.desired.labelNormalized,
        input.desired.labelDisplay,
        now,
      ],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }

  // Readback AFTER commit — the buffered tx can't read the inserted row.
  const result = await client.execute({
    sql: `SELECT * FROM community_handles WHERE community_handle_id = ?1 LIMIT 1`,
    args: [handleId],
  })
  const handle = result.rows[0]
  if (!handle) {
    throw internalError("Created reserved community handle row is missing")
  }
  return handle
}

export async function revokeCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  handleId: string
  body?: CommunityHandleRevokeRequest | null
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandle> {
  void input.body
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const rawHandleId = normalizeSubmittedPrefixedId("ch", input.handleId)
  if (!rawHandleId) {
    throw badRequestError("handle id is required")
  }
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const now = nowIso()
    await db.client.execute({
      sql: `
        UPDATE community_handles
        SET status = 'revoked',
            lease_expires_at = COALESCE(lease_expires_at, ?3),
            updated_at = ?3
        WHERE community_handle_id = ?1
          AND community_id = ?2
          AND status IN ('active', 'grace_period', 'reserved')
      `,
      args: [rawHandleId, input.communityId, now],
    })
    const result = await db.client.execute({
      sql: `
        SELECT *
        FROM community_handles
        WHERE community_handle_id = ?1
          AND community_id = ?2
        LIMIT 1
      `,
      args: [rawHandleId, input.communityId],
    })
    const handle = result.rows[0]
    if (!handle) {
      throw notFoundError("Community handle not found")
    }
    return serializeHandle(handle)
  } finally {
    db.close()
  }
}

export async function quoteCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityHandleQuoteRequest
  userRepository: UserRepository
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandleQuote> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }
  const desired = normalizeCommunityHandleLabel(input.body.desired_label)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const policy = await getNamespacePolicy(db.client, input.communityId)
    if (!policy) {
      throw eligibilityFailed("Community names are not available for this community")
    }
    if (!policy.claims_enabled) {
      throw eligibilityFailed("Community name claims are currently disabled")
    }
    const settings = parseSettings(policy.settings_json)
    const claimAccess = await requireClaimAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })

    assertLabelLength(desired.labelNormalized, settings)
    const activeForUser = await getActiveHandleForUser(db.client, policy.namespace_id, input.userId)
    const blockingForLabel = await getBlockingHandleForLabel(db.client, policy.namespace_id, desired.labelNormalized)

    let eligible = true
    let availability: Availability = "available"
    let reason: string | null = null
    if (isReservedLabel(desired.labelNormalized, settings)) {
      eligible = false
      availability = "reserved"
      reason = "Desired label is reserved"
    } else if (activeForUser && requiredString(activeForUser, "label_normalized") === desired.labelNormalized) {
      eligible = false
      availability = "already_claimed_by_viewer"
      reason = "Desired label is already active for this community"
    } else if (activeForUser) {
      eligible = false
      availability = "viewer_has_claim"
      reason = "You already have an active name in this community"
    } else if (blockingForLabel) {
      eligible = false
      const status = requiredString(blockingForLabel, "status")
      availability = status === "reserved" ? "reserved" : "taken"
      reason = status === "reserved" ? "Desired label is reserved" : "Desired label is unavailable"
    }

    const price = resolvePrice({
      labelNormalized: desired.labelNormalized,
      policy,
      settings,
    })
    const moneyPolicy = await getCommunityMoneyPolicy({ env: input.env, communityId: input.communityId })
    const quoteTtlSeconds = settings.quote_ttl_seconds ?? moneyPolicy.quote_ttl_seconds ?? DEFAULT_HANDLE_QUOTE_TTL_SECONDS
    const requiresProtocolIssuance = requireProtocolIssuanceSupport(policy, settings)
    const protocolOwner = requiresProtocolIssuance
      ? findTaprootProtocolOwnerWallet(await input.userRepository.getWalletAttachmentsByUserId(input.userId))
      : null
    const protocolIssuanceEligible = !requiresProtocolIssuance || protocolOwner != null
    const protocolIssuanceReason = requiresProtocolIssuance && !protocolOwner
      ? "A Bitcoin Taproot wallet is required for protocol-issued names"
      : null
    if (!protocolIssuanceEligible && eligible) {
      eligible = false
      reason = protocolIssuanceReason
    }
    const quotedAt = nowIso()
    await expireStaleHandleQuotes({
      executor: db.client,
      communityId: input.communityId,
      userId: input.userId,
      now: quotedAt,
    })
    const existingQuote = (await db.client.execute({
      sql: `
        SELECT *
        FROM community_handle_claim_quotes
        WHERE community_id = ?1
          AND user_id = ?2
          AND namespace_id = ?3
          AND label_normalized = ?4
          AND status = 'quoted'
          AND expires_at > ?5
        ORDER BY created_at DESC
        LIMIT 8
      `,
      args: [input.communityId, input.userId, policy.namespace_id, desired.labelNormalized, quotedAt],
    })).rows.find((row) => {
      return requiredNumber(row, "price_cents") === price.priceCents
        && stringOrNull(rowValue(row, "currency")) === "USD"
        && stringOrNull(rowValue(row, "pricing_model")) === price.pricingModel
        && stringOrNull(rowValue(row, "pricing_tier")) === price.pricingTier
    })
    if (existingQuote) {
      return serializeQuote(existingQuote, {
        env: input.env,
        desiredLabel: desired.labelDisplay,
        eligible,
        availability,
        reason,
        protocolIssuanceRequired: requiresProtocolIssuance,
        protocolIssuanceEligible,
        protocolIssuanceReason,
      })
    }
    const expiresAt = addSeconds(quotedAt, quoteTtlSeconds)
    const quoteId = makeId("hcq")

    await db.client.execute({
      sql: `
        INSERT INTO community_handle_claim_quotes (
          handle_claim_quote_id, community_id, user_id, namespace_id, label_normalized, label_display,
          status, price_cents, currency, pricing_model, pricing_tier, quote_ttl_seconds,
          quoted_at, expires_at, claimed_at, settings_snapshot_json, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6,
          'quoted', ?7, 'USD', ?8, ?9, ?10,
          ?11, ?12, NULL, ?13, ?11, ?11
        )
      `,
      args: [
        quoteId,
        input.communityId,
        input.userId,
        policy.namespace_id,
        desired.labelNormalized,
        desired.labelDisplay,
        price.priceCents,
        price.pricingModel,
        price.pricingTier,
        quoteTtlSeconds,
        quotedAt,
        expiresAt,
        JSON.stringify({
          policy_template: policy.policy_template,
          pricing_model: policy.pricing_model,
          claims_enabled: policy.claims_enabled,
          is_member: claimAccess.isMember,
          settings,
        }),
      ],
    })

    const row = (await db.client.execute({
      sql: `SELECT * FROM community_handle_claim_quotes WHERE handle_claim_quote_id = ?1 LIMIT 1`,
      args: [quoteId],
    })).rows[0]
    if (!row) {
      throw internalError("Created handle quote row is missing")
    }
    return serializeQuote(row, {
      env: input.env,
      desiredLabel: desired.labelDisplay,
      eligible,
      availability,
      reason,
      protocolIssuanceRequired: requiresProtocolIssuance,
      protocolIssuanceEligible,
      protocolIssuanceReason,
    })
  } finally {
    db.close()
  }
}

async function verifyPaymentForPaidClaim(input: {
  env: Env
  body: CommunityHandleClaimRequest
  quoteId: string
  priceCents: number
  userWalletAttachments: Awaited<ReturnType<UserRepository["getWalletAttachmentsByUserId"]>>
}): Promise<void> {
  if (input.priceCents <= 0) {
    return
  }
  const walletAttachment = input.body.settlement_wallet_attachment?.trim()
  if (!walletAttachment) {
    throw badRequestError("settlement_wallet_attachment is required for paid handle claims")
  }
  const wallet = input.userWalletAttachments.find((attachment) => attachment.wallet_attachment === walletAttachment)
  if (!wallet) {
    throw eligibilityFailed("settlement_wallet_attachment is not available for this user")
  }
  if (!wallet.chain_namespace.startsWith("eip155:")) {
    throw eligibilityFailed("settlement_wallet_attachment must be an EVM wallet")
  }
  if (!input.body.funding_tx_ref?.trim()) {
    throw badRequestError("funding_tx_ref is required for paid handle claims")
  }
  await verifyPirateCheckoutUsdcFunding({
    env: input.env,
    quoteId: input.quoteId,
    amountUsd: input.priceCents / 100,
    buyerAddress: wallet.wallet_address,
    fundingTxRef: input.body.funding_tx_ref,
  })
}

async function getExistingHandleForQuote(
  executor: Client | Transaction,
  quoteId: string,
): Promise<QueryResultRow | null> {
  const existingForQuote = await executor.execute({
    sql: `
      SELECT ${HANDLE_PROTOCOL_ISSUANCE_SELECT}
      FROM community_handles ch
      ${HANDLE_PROTOCOL_ISSUANCE_JOIN}
      WHERE ch.handle_claim_quote_id = ?1
      LIMIT 1
    `,
    args: [quoteId],
  })
  return existingForQuote.rows[0] ?? null
}

async function createProtocolIssuanceForHandle(input: {
  executor: Client | Transaction
  communityId: string
  namespaceId: string
  namespaceNormalizedLabel: string
  communityHandleId: string
  labelNormalized: string
  scriptPubkeyHex: string
  now: string
}): Promise<void> {
  const parentSpace = parentSpaceFromNamespaceLabel(input.namespaceNormalizedLabel)
  const sname = protocolSnameForHandle(input.labelNormalized, parentSpace)
  await input.executor.execute({
    sql: `
      INSERT INTO community_handle_protocol_issuances (
        community_handle_protocol_issuance_id,
        community_handle_id,
        protocol_issuance_batch_id,
        community_id,
        namespace_id,
        public_status,
        parent_space,
        sname,
        script_pubkey_hex,
        cert_ref,
        certificate_payload_ref,
        error_code,
        error_message,
        created_at,
        updated_at,
        issued_at
      ) VALUES (
        ?1,
        ?2,
        NULL,
        ?3,
        ?4,
        'issuing',
        ?5,
        ?6,
        ?7,
        NULL,
        NULL,
        NULL,
        NULL,
        ?8,
        ?8,
        NULL
      )
    `,
    args: [
      makeId("chpi"),
      input.communityHandleId,
      input.communityId,
      input.namespaceId,
      parentSpace,
      sname,
      input.scriptPubkeyHex,
      input.now,
    ],
  })
}

async function getClaimQuote(
  executor: Client | Transaction,
  input: {
    quoteId: string
    communityId: string
    userId: string
  },
): Promise<QueryResultRow> {
  const quoteResult = await executor.execute({
    sql: `
      SELECT *
      FROM community_handle_claim_quotes
      WHERE handle_claim_quote_id = ?1
        AND community_id = ?2
        AND user_id = ?3
      LIMIT 1
    `,
    args: [input.quoteId, input.communityId, input.userId],
  })
  const quote = quoteResult.rows[0]
  if (!quote) {
    throw notFoundError("Handle quote not found")
  }
  return quote
}

async function assertClaimQuoteStillClaimable(input: {
  executor: Client | Transaction
  communityId: string
  userId: string
  quoteId: string
  quote: QueryResultRow
  now: string
  paymentVerified: boolean
}): Promise<{
  policy: NamespacePolicyRow
  labelNormalized: string
  labelDisplay: string
  priceCents: number
  protocolIssuanceRequired: boolean
}> {
  const status = requiredString(input.quote, "status")
  await expireStaleHandleQuotes({
    executor: input.executor,
    communityId: input.communityId,
    userId: input.userId,
    now: input.now,
  })
  if (status !== "quoted") {
    throw eligibilityFailed("Handle quote is no longer claimable")
  }
  if (Date.parse(requiredString(input.quote, "expires_at")) <= Date.parse(input.now)) {
    await input.executor.execute({
      sql: `
        UPDATE community_handle_claim_quotes
        SET status = 'expired',
            updated_at = ?2
        WHERE handle_claim_quote_id = ?1
      `,
      args: [input.quoteId, input.now],
    })
    throw eligibilityFailed("Handle quote has expired")
  }

  const policy = await getNamespacePolicy(input.executor, input.communityId)
  if (!policy || policy.namespace_id !== requiredString(input.quote, "namespace_id")) {
    throw eligibilityFailed("Community names are not available for this community")
  }
  if (!policy.claims_enabled) {
    throw eligibilityFailed("Community name claims are currently disabled")
  }
  const settings = parseSettings(policy.settings_json)
  await requireClaimAccess({
    client: input.executor,
    communityId: input.communityId,
    userId: input.userId,
  })

  const labelNormalized = requiredString(input.quote, "label_normalized")
  const labelDisplay = requiredString(input.quote, "label_display")
  if (isReservedLabel(labelNormalized, settings)) {
    const reason = "Desired label is reserved"
    throw eligibilityFailed(reason, availabilityDetails("reserved", reason))
  }
  const activeForUser = await getActiveHandleForUser(input.executor, policy.namespace_id, input.userId)
  if (activeForUser) {
    const activeLabel = requiredString(activeForUser, "label_normalized")
    const availability: Availability = activeLabel === labelNormalized
      ? "already_claimed_by_viewer"
      : "viewer_has_claim"
    const reason = input.paymentVerified
      ? "Payment was verified, but you already have an active name in this community"
      : activeLabel === labelNormalized
        ? "Desired label is already active for this community"
        : "You already have an active name in this community"
    throw conflictError(reason, availabilityDetails(availability, reason))
  }
  const blockingForLabel = await getBlockingHandleForLabel(input.executor, policy.namespace_id, labelNormalized)
  if (blockingForLabel) {
    const status = requiredString(blockingForLabel, "status")
    const reason = input.paymentVerified
      ? "Payment was verified, but this name became unavailable before the claim completed"
      : status === "reserved" ? "Desired label is reserved" : "Desired label is unavailable"
    throw conflictError(reason, availabilityDetails(status === "reserved" ? "reserved" : "taken", reason))
  }

  return {
    policy,
    labelNormalized,
    labelDisplay,
    priceCents: requiredNumber(input.quote, "price_cents"),
    protocolIssuanceRequired: requireProtocolIssuanceSupport(policy, settings),
  }
}

export async function claimCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityHandleClaimRequest
  userRepository: UserRepository
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandle> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }
  if (typeof input.body.quote !== "string") {
    throw badRequestError("Invalid quote")
  }
  const submittedQuoteId = input.body.quote.trim()
  const quoteId = submittedQuoteId.startsWith("hcq_hcq_")
    ? submittedQuoteId.slice("hcq_".length)
    : submittedQuoteId
  if (!quoteId.trim()) {
    throw badRequestError("quote is required")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  let priceCents = 0
  let requiresProtocolIssuance = false
  let protocolOwner: { walletAttachmentId: string; scriptPubkeyHex: string } | null = null
  try {
    const quote = await getClaimQuote(db.client, {
      quoteId,
      communityId: input.communityId,
      userId: input.userId,
    })
    const existing = await getExistingHandleForQuote(db.client, quoteId)
    if (existing) {
      return serializeHandle(existing)
    }
    const checked = await assertClaimQuoteStillClaimable({
      executor: db.client,
      communityId: input.communityId,
      userId: input.userId,
      quoteId,
      quote,
      now: nowIso(),
      paymentVerified: false,
    })
    priceCents = checked.priceCents
    requiresProtocolIssuance = checked.protocolIssuanceRequired
  } finally {
    db.close()
  }

  if (requiresProtocolIssuance) {
    protocolOwner = await requireProtocolOwnerWalletForClaim({
      body: input.body,
      userId: input.userId,
      userRepository: input.userRepository,
    })
  }

  if (priceCents > 0) {
    await verifyPaymentForPaidClaim({
      env: input.env,
      body: input.body,
      quoteId,
      priceCents,
      userWalletAttachments: await input.userRepository.getWalletAttachmentsByUserId(input.userId),
    })
  }
  const paymentVerified = priceCents > 0

  const writeDb = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    // Final, authoritative validation on the base client BEFORE the tx. A buffered
    // D1 write tx can't read the quote/handle back mid-flight, and
    // assertClaimQuoteStillClaimable both reads (policy, active handle, blocking
    // handle, membership) and writes (expireStaleHandleQuotes) — none of which would
    // observe correct state inside the buffered batch. The (namespace, label) partial
    // unique index is the real concurrency gate for the write below.
    const quote = await getClaimQuote(writeDb.client, {
      quoteId,
      communityId: input.communityId,
      userId: input.userId,
    })

    const existingForQuote = await getExistingHandleForQuote(writeDb.client, quoteId)
    if (existingForQuote) {
      return serializeHandle(existingForQuote)
    }

    const now = nowIso()
    const checked = await assertClaimQuoteStillClaimable({
      executor: writeDb.client,
      communityId: input.communityId,
      userId: input.userId,
      quoteId,
      quote,
      now,
      paymentVerified,
    })
    if (checked.protocolIssuanceRequired && !protocolOwner) {
      throw eligibilityFailed("protocol_owner_wallet_attachment is required for protocol-issued names", {
        protocol_owner_wallet_attachment: "missing",
      })
    }
    const persistedProtocolOwnerWalletAttachmentId = checked.protocolIssuanceRequired
      ? protocolOwner?.walletAttachmentId ?? null
      : null

    return serializeHandle(await applyHandleClaimWrites(writeDb.client, {
      communityId: input.communityId,
      userId: input.userId,
      quoteId,
      namespaceId: checked.policy.namespace_id,
      namespaceNormalizedLabel: checked.policy.normalized_label,
      labelNormalized: checked.labelNormalized,
      labelDisplay: checked.labelDisplay,
      priceCents: checked.priceCents,
      pricingModel: stringOrNull(rowValue(quote, "pricing_model")),
      pricingTier: stringOrNull(rowValue(quote, "pricing_tier")),
      settlementWalletAttachmentId: input.body.settlement_wallet_attachment?.trim() || null,
      protocolOwnerWalletAttachmentId: persistedProtocolOwnerWalletAttachmentId,
      fundingTxRef: input.body.funding_tx_ref?.trim() || null,
      settlementTxRef: input.body.settlement_tx_ref?.trim() || input.body.funding_tx_ref?.trim() || null,
      protocolIssuanceRequired: checked.protocolIssuanceRequired,
      protocolOwner,
      now,
    }))
  } finally {
    writeDb.close()
  }
}

/**
 * Buffer-safe write phase of a handle claim. All validation/reads happen in the
 * caller on the base client BEFORE this runs; here the tx body is write-only (handle
 * INSERT + optional protocol issuance + quote transition, atomic via db.batch). The
 * (namespace, label) partial unique index rejects a concurrent winner at commit(); we
 * then resolve idempotently. The created row is read back AFTER commit. Exported for
 * buffer-safety regression tests.
 */
export async function applyHandleClaimWrites(
  client: Client,
  input: {
    communityId: string
    userId: string
    quoteId: string
    namespaceId: string
    namespaceNormalizedLabel: string
    labelNormalized: string
    labelDisplay: string
    priceCents: number
    pricingModel: string | null
    pricingTier: string | null
    settlementWalletAttachmentId: string | null
    protocolOwnerWalletAttachmentId: string | null
    fundingTxRef: string | null
    settlementTxRef: string | null
    protocolIssuanceRequired: boolean
    protocolOwner: { walletAttachmentId: string; scriptPubkeyHex: string } | null
    now: string
  },
): Promise<QueryResultRow> {
  const handleId = makeId("ch")
  const tx = await client.transaction("write")
  try {
    await tx.execute({
      sql: `
        INSERT INTO community_handles (
          community_handle_id, community_id, user_id, namespace_id, handle_claim_quote_id,
          label_normalized, label_display, status, issuance_source, price_cents, currency,
          pricing_model, pricing_tier, settlement_wallet_attachment_id, protocol_owner_wallet_attachment_id, funding_tx_ref, settlement_tx_ref,
          lease_started_at, lease_expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, 'active', 'claim', ?8, 'USD',
          ?9, ?10, ?11, ?12, ?13, ?14,
          ?15, NULL, ?15, ?15
        )
      `,
      args: [
        handleId,
        input.communityId,
        input.userId,
        input.namespaceId,
        input.quoteId,
        input.labelNormalized,
        input.labelDisplay,
        input.priceCents,
        input.pricingModel,
        input.pricingTier,
        input.settlementWalletAttachmentId,
        input.protocolOwnerWalletAttachmentId,
        input.fundingTxRef,
        input.settlementTxRef,
        input.now,
      ],
    })

    if (input.protocolIssuanceRequired) {
      if (!input.protocolOwner) {
        throw internalError("Protocol owner wallet validation result is missing")
      }
      await createProtocolIssuanceForHandle({
        executor: tx,
        communityId: input.communityId,
        namespaceId: input.namespaceId,
        namespaceNormalizedLabel: input.namespaceNormalizedLabel,
        communityHandleId: handleId,
        labelNormalized: input.labelNormalized,
        scriptPubkeyHex: input.protocolOwner.scriptPubkeyHex,
        now: input.now,
      })
    }

    await tx.execute({
      sql: `
        UPDATE community_handle_claim_quotes
        SET status = 'claimed',
            claimed_at = ?2,
            updated_at = ?2
        WHERE handle_claim_quote_id = ?1
          AND status = 'quoted'
      `,
      args: [input.quoteId, input.now],
    })

    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    // The (namespace, label) partial unique index may have rejected the INSERT at
    // commit because a concurrent claim won the label. Resolve idempotently:
    const racedForQuote = await getExistingHandleForQuote(client, input.quoteId)
    if (racedForQuote) {
      return racedForQuote
    }
    const blocking = await getBlockingHandleForLabel(client, input.namespaceId, input.labelNormalized)
    if (blocking) {
      const blockingStatus = requiredString(blocking, "status")
      const reason = "Payment was verified, but this name became unavailable before the claim completed"
      throw conflictError(reason, availabilityDetails(blockingStatus === "reserved" ? "reserved" : "taken", reason))
    }
    throw error
  } finally {
    tx.close()
  }

  // Readback AFTER commit — the buffered tx can't read the inserted row.
  const handleResult = await client.execute({
    sql: `
      SELECT ${HANDLE_PROTOCOL_ISSUANCE_SELECT}
      FROM community_handles ch
      ${HANDLE_PROTOCOL_ISSUANCE_JOIN}
      WHERE ch.community_handle_id = ?1
      LIMIT 1
    `,
    args: [handleId],
  })
  const handle = handleResult.rows[0]
  if (!handle) {
    throw internalError("Created community handle row is missing")
  }
  return handle
}
