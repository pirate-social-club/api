import type {
  CommunityHandle,
  CommunityHandleClaimRequest,
  CommunityHandleMeResponse,
  CommunityHandlePolicy,
  CommunityHandlePolicySettings,
  CommunityHandleQuote,
  CommunityHandleQuoteRequest,
  Env,
  UpdateCommunityHandlePolicyRequest,
} from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { conflictError, badRequestError, eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import type { Client, QueryResultRow, Transaction } from "../../sql-client"
import { numberOrNull, requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"
import { nullableUnixSeconds, unixSeconds } from "../../../serializers/time"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityReadRepository } from "../db-community-repository"
import { requireCommunityMember, requireCommunityOwner } from "../commerce/access"
import {
  resolvePirateCheckoutOperatorAddress,
  resolvePirateCheckoutSourceChainId,
  resolvePirateCheckoutSourceChainName,
  resolvePirateCheckoutUsdcTokenAddress,
} from "../commerce/checkout-config"
import { verifyPirateCheckoutUsdcFunding } from "../commerce/funding-proof-service"
import { getCommunityMoneyPolicy } from "../commerce/policy-service"

type HandlePricingModel = NonNullable<CommunityHandleQuote["pricing_model"]>

type NamespacePolicyRow = {
  namespace_handle_policy_id: string
  community_id: string
  namespace_id: string
  display_label: string
  normalized_label: string
  policy_template: CommunityHandlePolicy["policy_template"]
  pricing_model: HandlePricingModel | null
  membership_required_for_claim: boolean
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
const DEFAULT_PREMIUM_MAX_LENGTH = 6
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

export function normalizeCommunityHandleLabel(desiredLabel: string): {
  labelNormalized: string
  labelDisplay: string
} {
  const trimmed = desiredLabel.trim().toLowerCase()
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed
  const withoutSuffix = withoutAt.includes("@") ? withoutAt.slice(0, withoutAt.indexOf("@")) : withoutAt

  if (!withoutSuffix || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(withoutSuffix)) {
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
      reserved_labels: Array.isArray(parsed.reserved_labels)
        ? parsed.reserved_labels.filter((value): value is string => typeof value === "string")
        : undefined,
    }
  } catch {
    throw internalError("Community handle policy settings are malformed", {
      reason: "invalid_settings_json",
    })
  }
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

function serializePolicy(row: NamespacePolicyRow): CommunityHandlePolicy {
  return {
    id: withPrefix("nhp", row.namespace_handle_policy_id),
    object: "community_handle_policy",
    community: withPrefix("com", row.community_id),
    namespace: withPrefix("ns", row.namespace_id),
    policy_template: row.policy_template,
    pricing_model: row.pricing_model,
    membership_required_for_claim: row.membership_required_for_claim,
    settings: parseSettings(row.settings_json),
    updated_at: nullableUnixSeconds(row.updated_at),
  }
}

function serializeHandle(row: QueryResultRow): CommunityHandle {
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
    funding_tx_ref: stringOrNull(rowValue(row, "funding_tx_ref")),
    settlement_tx_ref: stringOrNull(rowValue(row, "settlement_tx_ref")),
    lease_started_at: nullableUnixSeconds(stringOrNull(rowValue(row, "lease_started_at"))),
    lease_expires_at: nullableUnixSeconds(stringOrNull(rowValue(row, "lease_expires_at"))),
    created: unixSeconds(requiredString(row, "created_at")),
  }
}

function serializeQuote(row: QueryResultRow, input: {
  env: Env
  eligible: boolean
  availability: Availability
  reason: string | null
  desiredLabel: string
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
      SELECT nb.community_id, nb.namespace_id, nb.display_label, nb.normalized_label,
             nhp.namespace_handle_policy_id, nhp.policy_template, nhp.pricing_model,
             nhp.membership_required_for_claim, nhp.settings_json, nhp.updated_at
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
    policy_template: (stringOrNull(rowValue(row, "policy_template")) ?? "standard") as CommunityHandlePolicy["policy_template"],
    pricing_model: stringOrNull(rowValue(row, "pricing_model")) as HandlePricingModel | null,
    membership_required_for_claim: numberOrNull(rowValue(row, "membership_required_for_claim")) !== 0,
    settings_json: stringOrNull(rowValue(row, "settings_json")),
    updated_at: stringOrNull(rowValue(row, "updated_at")),
  }
}

async function getActiveHandleForLabel(
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
        AND status = 'active'
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
      SELECT *
      FROM community_handles
      WHERE namespace_id = ?1
        AND user_id = ?2
        AND status = 'active'
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

  const premiumMaxLength = input.settings.premium_max_length ?? DEFAULT_PREMIUM_MAX_LENGTH
  const isPremium = input.labelNormalized.length <= premiumMaxLength
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

function sanitizeSettings(input: CommunityHandlePolicySettings | null | undefined): HandleClaimSettings {
  if (!input) return {}
  const settings: HandleClaimSettings = {
    flat_price_cents: optionalIntegerSetting(input.flat_price_cents, "flat_price_cents", { min: 0 }),
    premium_price_cents: optionalIntegerSetting(input.premium_price_cents, "premium_price_cents", { min: 0 }),
    premium_max_length: optionalIntegerSetting(input.premium_max_length, "premium_max_length", { min: 1 }),
    min_length: optionalIntegerSetting(input.min_length, "min_length", { min: 1 }),
    max_length: optionalIntegerSetting(input.max_length, "max_length", { min: 1 }),
    quote_ttl_seconds: optionalIntegerSetting(input.quote_ttl_seconds, "quote_ttl_seconds", { min: 60 }),
    reserved_labels: Array.isArray(input.reserved_labels)
      ? input.reserved_labels.map((label) => normalizeCommunityHandleLabel(label).labelNormalized)
      : undefined,
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
  policy: NamespacePolicyRow
}): Promise<void> {
  if (input.policy.membership_required_for_claim) {
    await requireCommunityMember(input.client as Client, input.communityId, input.userId)
  }
}

export async function getMyCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
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

export async function getCommunityHandlePolicy(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
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
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
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
    const updatedAt = nowIso()
    await db.client.execute({
      sql: `
        INSERT INTO namespace_handle_policies (
          namespace_handle_policy_id, community_id, namespace_id, policy_template, pricing_model,
          membership_required_for_claim, settings_json, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
        )
        ON CONFLICT(namespace_handle_policy_id) DO UPDATE SET
          policy_template = excluded.policy_template,
          pricing_model = excluded.pricing_model,
          membership_required_for_claim = excluded.membership_required_for_claim,
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
        "membership_required_for_claim" in input.body
          ? input.body.membership_required_for_claim === true ? 1 : 0
          : current.membership_required_for_claim ? 1 : 0,
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

export async function quoteCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityHandleQuoteRequest
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
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
    await requireClaimAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
      policy,
    })

    const settings = parseSettings(policy.settings_json)
    assertLabelLength(desired.labelNormalized, settings)
    const activeForUser = await getActiveHandleForUser(db.client, policy.namespace_id, input.userId)
    const activeForLabel = await getActiveHandleForLabel(db.client, policy.namespace_id, desired.labelNormalized)

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
    } else if (activeForLabel) {
      eligible = false
      availability = "taken"
      reason = "Desired label is unavailable"
    }

    const price = resolvePrice({
      labelNormalized: desired.labelNormalized,
      policy,
      settings,
    })
    const moneyPolicy = await getCommunityMoneyPolicy({ env: input.env, communityId: input.communityId })
    const quoteTtlSeconds = settings.quote_ttl_seconds ?? moneyPolicy.quote_ttl_seconds ?? DEFAULT_HANDLE_QUOTE_TTL_SECONDS
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
        desiredLabel: input.body.desired_label,
        eligible,
        availability,
        reason,
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
          membership_required_for_claim: policy.membership_required_for_claim,
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
      desiredLabel: input.body.desired_label,
      eligible,
      availability,
      reason,
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

export async function claimCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityHandleClaimRequest
  userRepository: UserRepository
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
}): Promise<CommunityHandle> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }
  const submittedQuoteId = input.body.quote.trim()
  const quoteId = submittedQuoteId.startsWith("hcq_hcq_")
    ? submittedQuoteId.slice("hcq_".length)
    : submittedQuoteId
  if (!quoteId.trim()) {
    throw badRequestError("quote is required")
  }
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const tx = await db.client.transaction("write")
    try {
      const quoteResult = await tx.execute({
        sql: `
          SELECT *
          FROM community_handle_claim_quotes
          WHERE handle_claim_quote_id = ?1
            AND community_id = ?2
            AND user_id = ?3
          LIMIT 1
        `,
        args: [quoteId, input.communityId, input.userId],
      })
      const quote = quoteResult.rows[0]
      if (!quote) {
        throw notFoundError("Handle quote not found")
      }

      const existingForQuote = await tx.execute({
        sql: `
          SELECT *
          FROM community_handles
          WHERE handle_claim_quote_id = ?1
          LIMIT 1
        `,
        args: [quoteId],
      })
      if (existingForQuote.rows[0]) {
        await tx.commit()
        return serializeHandle(existingForQuote.rows[0])
      }

      const status = requiredString(quote, "status")
      const now = nowIso()
      await expireStaleHandleQuotes({
        executor: tx,
        communityId: input.communityId,
        userId: input.userId,
        now,
      })
      if (status !== "quoted") {
        throw eligibilityFailed("Handle quote is no longer claimable")
      }
      if (Date.parse(requiredString(quote, "expires_at")) <= Date.parse(now)) {
        await tx.execute({
          sql: `
            UPDATE community_handle_claim_quotes
            SET status = 'expired',
                updated_at = ?2
            WHERE handle_claim_quote_id = ?1
          `,
          args: [quoteId, now],
        })
        await tx.commit()
        throw eligibilityFailed("Handle quote has expired")
      }

      const policy = await getNamespacePolicy(tx, input.communityId)
      if (!policy || policy.namespace_id !== requiredString(quote, "namespace_id")) {
        throw eligibilityFailed("Community names are not available for this community")
      }
      await requireClaimAccess({
        client: tx,
        communityId: input.communityId,
        userId: input.userId,
        policy,
      })

      const settings = parseSettings(policy.settings_json)
      const labelNormalized = requiredString(quote, "label_normalized")
      const labelDisplay = requiredString(quote, "label_display")
      if (isReservedLabel(labelNormalized, settings)) {
        const reason = "Desired label is reserved"
        throw eligibilityFailed(reason, availabilityDetails("reserved", reason))
      }
      const activeForUser = await getActiveHandleForUser(tx, policy.namespace_id, input.userId)
      if (activeForUser) {
        const activeLabel = requiredString(activeForUser, "label_normalized")
        const availability: Availability = activeLabel === labelNormalized
          ? "already_claimed_by_viewer"
          : "viewer_has_claim"
        const reason = activeLabel === labelNormalized
          ? "Desired label is already active for this community"
          : "You already have an active name in this community"
        throw conflictError(reason, availabilityDetails(availability, reason))
      }
      const activeForLabel = await getActiveHandleForLabel(tx, policy.namespace_id, labelNormalized)
      if (activeForLabel) {
        const reason = "Desired label is unavailable"
        throw conflictError(reason, availabilityDetails("taken", reason))
      }

      const priceCents = requiredNumber(quote, "price_cents")
      await verifyPaymentForPaidClaim({
        env: input.env,
        body: input.body,
        quoteId,
        priceCents,
        userWalletAttachments: await input.userRepository.getWalletAttachmentsByUserId(input.userId),
      })

      const handleId = makeId("ch")
      await tx.execute({
        sql: `
          INSERT INTO community_handles (
            community_handle_id, community_id, user_id, namespace_id, handle_claim_quote_id,
            label_normalized, label_display, status, issuance_source, price_cents, currency,
            pricing_model, pricing_tier, settlement_wallet_attachment_id, funding_tx_ref, settlement_tx_ref,
            lease_started_at, lease_expires_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, 'active', 'claim', ?8, 'USD',
            ?9, ?10, ?11, ?12, ?13,
            ?14, NULL, ?14, ?14
          )
        `,
        args: [
          handleId,
          input.communityId,
          input.userId,
          policy.namespace_id,
          quoteId,
          labelNormalized,
          labelDisplay,
          priceCents,
          stringOrNull(rowValue(quote, "pricing_model")),
          stringOrNull(rowValue(quote, "pricing_tier")),
          input.body.settlement_wallet_attachment?.trim() || null,
          input.body.funding_tx_ref?.trim() || null,
          input.body.settlement_tx_ref?.trim() || input.body.funding_tx_ref?.trim() || null,
          now,
        ],
      })

      await tx.execute({
        sql: `
          UPDATE community_handle_claim_quotes
          SET status = 'claimed',
              claimed_at = ?2,
              updated_at = ?2
          WHERE handle_claim_quote_id = ?1
        `,
        args: [quoteId, now],
      })

      const handleResult = await tx.execute({
        sql: `SELECT * FROM community_handles WHERE community_handle_id = ?1 LIMIT 1`,
        args: [handleId],
      })
      const handle = handleResult.rows[0]
      if (!handle) {
        throw internalError("Created community handle row is missing")
      }
      await tx.commit()
      return serializeHandle(handle)
    } catch (error) {
      await tx.rollback().catch(() => undefined)
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}
