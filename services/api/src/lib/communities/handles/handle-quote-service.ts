import type { CommunityHandleQuote, CommunityHandleQuoteRequest, Env } from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"
import { openCommunityWriteClient } from "../community-read-access"
import { getCommunityMoneyPolicy } from "../commerce/policy-service"
import { requireHandleClaimAccess } from "./handle-access"
import { expireStaleHandleQuotes } from "./handle-claim-validation"
import {
  type HandleCommunityRepository,
  getNamespacePolicy,
  normalizeCommunityHandleLabel,
  parseHandleClaimSettings,
} from "./handle-policy-service"
import {
  findTaprootProtocolOwnerWallet,
  requireProtocolIssuanceSupport,
} from "./handle-protocol-issuance"
import {
  DEFAULT_HANDLE_QUOTE_TTL_SECONDS,
  type HandleAvailability,
  addHandleQuoteSeconds,
  assertHandleLabelLength,
  isReservedHandleLabel,
  resolveHandlePrice,
  serializeHandleQuote,
} from "./handle-quote-domain"
import { getActiveHandleForUser, getBlockingHandleForLabel } from "./handle-row-store"

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
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const policy = await getNamespacePolicy(db.client, input.communityId)
    if (!policy) {
      throw eligibilityFailed("Community names are not available for this community")
    }
    if (!policy.claims_enabled) {
      throw eligibilityFailed("Community name claims are currently disabled")
    }
    const settings = parseHandleClaimSettings(policy.settings_json)
    const claimAccess = await requireHandleClaimAccess({ client: db.client, communityId: input.communityId, userId: input.userId })

    assertHandleLabelLength(desired.labelNormalized, settings)
    const activeForUser = await getActiveHandleForUser(db.client, policy.namespace_id, input.userId)
    const blockingForLabel = await getBlockingHandleForLabel(db.client, policy.namespace_id, desired.labelNormalized)

    let eligible = true
    let availability: HandleAvailability = "available"
    let reason: string | null = null
    if (isReservedHandleLabel(desired.labelNormalized, settings)) {
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

    const price = resolveHandlePrice({ labelNormalized: desired.labelNormalized, policy, settings })
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
    await expireStaleHandleQuotes({ executor: db.client, communityId: input.communityId, userId: input.userId, now: quotedAt })
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
      return serializeHandleQuote(existingQuote, {
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
    const expiresAt = addHandleQuoteSeconds(quotedAt, quoteTtlSeconds)
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
    return serializeHandleQuote(row, {
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
