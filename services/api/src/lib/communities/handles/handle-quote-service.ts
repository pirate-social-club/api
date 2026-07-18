import type { CommunityHandleQuote, CommunityHandleQuoteRequest, Env } from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { conflictError, eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"
import { openCommunityWriteClient } from "../community-read-access"
import { getCommunityMoneyPolicy } from "../commerce/policy-service"
import { evaluateNamespaceHandleClaimEligibility, requireHandleClaimAccess } from "./handle-access"
import { expireStaleHandleQuotes } from "./handle-claim-validation"
import { buildMembershipGateSummariesFromPolicy } from "../membership/gate-summary"
import {
  type HandleCommunityRepository,
  getNamespacePolicy,
  normalizeCommunityHandleLabel,
  parseHandleClaimSettings,
  withHandlePrefix,
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
  handleAvailabilityDetails,
  isReservedHandleLabel,
  resolveHandlePrice,
  serializeHandleQuote,
} from "./handle-quote-domain"
import { getActiveHandleForUser, getBlockingHandleForLabel } from "./handle-row-store"
import {
  acquireHandleLabelReservation,
  getActiveHandleLabelReservation,
  getActivePaymentHandleLabelReservationForUser,
} from "./handle-label-reservation"

export async function quoteCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  namespaceVerificationId?: string | null
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
    const policy = await getNamespacePolicy(db.client, input.communityId, {
      namespaceVerificationId: input.namespaceVerificationId,
    })
    if (!policy) {
      throw eligibilityFailed("Community names are not available for this community")
    }
    if (!policy.claims_enabled) {
      throw eligibilityFailed("Community name claims are currently disabled")
    }
    const settings = parseHandleClaimSettings(policy.settings_json)
    const claimAccess = await requireHandleClaimAccess({ client: db.client, communityId: input.communityId, userId: input.userId })
    const gateEligibility = await evaluateNamespaceHandleClaimEligibility({
      env: input.env,
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
      userRepository: input.userRepository,
      policy,
      labelNormalized: desired.labelNormalized,
    })
    const claimGate: CommunityHandleQuote["claim_gate"] = gateEligibility.gate
      ? {
        source: gateEligibility.gate.source,
        satisfied: gateEligibility.satisfied,
        label_claim_rule: gateEligibility.gate.ruleId ? withHandlePrefix("hlcr", gateEligibility.gate.ruleId) : null,
        expression: gateEligibility.gate.policy,
        summaries: buildMembershipGateSummariesFromPolicy(gateEligibility.gate.policy),
      }
      : null

    assertHandleLabelLength(desired.labelNormalized, settings)
    const activeForUser = await getActiveHandleForUser(db.client, policy.namespace_id, input.userId)
    const blockingForLabel = await getBlockingHandleForLabel(db.client, policy.namespace_id, desired.labelNormalized)

    let eligible = gateEligibility.satisfied
    let availability: HandleAvailability = "available"
    let reason: string | null = gateEligibility.reason
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
          AND (
            ?6 = 0 OR EXISTS (
              SELECT 1
              FROM community_handle_label_reservations hlr
              WHERE hlr.handle_claim_quote_id = community_handle_claim_quotes.handle_claim_quote_id
                AND hlr.purpose = 'payment'
                AND hlr.status = 'active'
                AND hlr.expires_at > ?5
            )
          )
        ORDER BY created_at DESC
        LIMIT 8
      `,
      args: [input.communityId, input.userId, policy.namespace_id, desired.labelNormalized, quotedAt, price.priceCents],
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
        claimGate,
      })
    }

    const activeUserPaymentReservation = price.priceCents > 0
      ? await getActivePaymentHandleLabelReservationForUser({
        executor: db.client,
        userId: input.userId,
        now: quotedAt,
      })
      : null
    if (activeUserPaymentReservation) {
      throw conflictError("An active paid handle quote must expire or be claimed before quoting another label", {
        reason: "active_payment_reservation",
        expires_at: requiredString(activeUserPaymentReservation, "expires_at"),
      })
    }

    const activePaymentReservation = price.priceCents > 0
      ? await getActiveHandleLabelReservation({
        executor: db.client,
        namespaceId: policy.namespace_id,
        labelNormalized: desired.labelNormalized,
        now: quotedAt,
      })
      : null
    if (activePaymentReservation) {
      eligible = false
      availability = "taken"
      reason = "Desired label is temporarily reserved for another payment"
    }
    const expiresAt = addHandleQuoteSeconds(quotedAt, quoteTtlSeconds)
    const quoteId = makeId("hcq")
    // Keep rejected quotes claimable long enough for the claim path to return the
    // authoritative policy/gate error. Only eligible paid quotes need to hold the
    // label mutex while the user funds them.
    const quoteStatus = "quoted"
    const reserveForPayment =
      eligible && availability === "available" && price.priceCents > 0

    const insertQuote = {
      sql: `
        INSERT INTO community_handle_claim_quotes (
          handle_claim_quote_id, community_id, user_id, namespace_id, label_normalized, label_display,
          status, price_cents, currency, pricing_model, pricing_tier, quote_ttl_seconds,
          quoted_at, expires_at, claimed_at, settings_snapshot_json, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6,
          ?7, ?8, 'USD', ?9, ?10, ?11,
          ?12, ?13, NULL, ?14, ?12, ?12
        )
      `,
      args: [
        quoteId,
        input.communityId,
        input.userId,
        policy.namespace_id,
        desired.labelNormalized,
        desired.labelDisplay,
        quoteStatus,
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
    }

    if (reserveForPayment) {
      const tx = await db.client.transaction("write")
      try {
        await tx.execute(insertQuote)
        await acquireHandleLabelReservation({
          executor: tx,
          communityId: input.communityId,
          namespaceId: policy.namespace_id,
          labelNormalized: desired.labelNormalized,
          userId: input.userId,
          quoteId,
          purpose: "payment",
          reservedAt: quotedAt,
          expiresAt,
        })
        await tx.commit()
      } catch (error) {
        await tx.rollback().catch(() => undefined)
        const racedReservation = await getActiveHandleLabelReservation({
          executor: db.client,
          namespaceId: policy.namespace_id,
          labelNormalized: desired.labelNormalized,
          now: quotedAt,
        })
        if (racedReservation) {
          const raceReason = "Desired label is temporarily reserved for another payment"
          throw conflictError(raceReason, handleAvailabilityDetails("taken", raceReason))
        }
        const racedUserReservation = await getActivePaymentHandleLabelReservationForUser({
          executor: db.client,
          userId: input.userId,
          now: quotedAt,
        })
        if (racedUserReservation) {
          throw conflictError("An active paid handle quote must expire or be claimed before quoting another label", {
            reason: "active_payment_reservation",
            expires_at: requiredString(racedUserReservation, "expires_at"),
          })
        }
        throw error
      } finally {
        tx.close()
      }
    } else {
      await db.client.execute(insertQuote)
    }

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
      claimGate,
    })
  } finally {
    db.close()
  }
}
