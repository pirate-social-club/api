import type {
  CommunityHandle,
  CommunityHandleClaimRequest,
  CommunityHandleQuote,
  CommunityHandleQuoteRequest,
  Env,
} from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { conflictError, badRequestError, eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import type { Client, QueryResultRow, Transaction } from "../../sql-client"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"
import { openCommunityWriteClient } from "../community-read-access"
import type { DbExecutor } from "../../db-helpers"
import { getCommunityMoneyPolicy } from "../commerce/policy-service"
import {
  type HandleCommunityRepository,
  type NamespacePolicyRow,
  getNamespacePolicy,
  normalizeCommunityHandleLabel,
  parseHandleClaimSettings,
} from "./handle-policy-service"
import { requireHandleClaimAccess } from "./handle-access"
import {
  HANDLE_PROTOCOL_ISSUANCE_JOIN,
  HANDLE_PROTOCOL_ISSUANCE_SELECT,
  getActiveHandleForUser,
  getBlockingHandleForLabel,
  serializeHandle,
} from "./handle-row-store"
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
import {
  createProtocolIssuanceForHandle,
  findTaprootProtocolOwnerWallet,
  requireProtocolIssuanceSupport,
  requireProtocolOwnerWalletForClaim,
} from "./handle-protocol-issuance"
import { verifyPaymentForPaidHandleClaim } from "./handle-payment-verification"

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
    const claimAccess = await requireHandleClaimAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })

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

    const price = resolveHandlePrice({
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

async function getExistingHandleForQuote(
  executor: DbExecutor,
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

async function getClaimQuote(
  executor: DbExecutor,
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
  const settings = parseHandleClaimSettings(policy.settings_json)
  await requireHandleClaimAccess({
    client: input.executor,
    communityId: input.communityId,
    userId: input.userId,
  })

  const labelNormalized = requiredString(input.quote, "label_normalized")
  const labelDisplay = requiredString(input.quote, "label_display")
  if (isReservedHandleLabel(labelNormalized, settings)) {
    const reason = "Desired label is reserved"
    throw eligibilityFailed(reason, handleAvailabilityDetails("reserved", reason))
  }
  const activeForUser = await getActiveHandleForUser(input.executor, policy.namespace_id, input.userId)
  if (activeForUser) {
    const activeLabel = requiredString(activeForUser, "label_normalized")
    const availability: HandleAvailability = activeLabel === labelNormalized
      ? "already_claimed_by_viewer"
      : "viewer_has_claim"
    const reason = input.paymentVerified
      ? "Payment was verified, but you already have an active name in this community"
      : activeLabel === labelNormalized
        ? "Desired label is already active for this community"
        : "You already have an active name in this community"
    throw conflictError(reason, handleAvailabilityDetails(availability, reason))
  }
  const blockingForLabel = await getBlockingHandleForLabel(input.executor, policy.namespace_id, labelNormalized)
  if (blockingForLabel) {
    const status = requiredString(blockingForLabel, "status")
    const reason = input.paymentVerified
      ? "Payment was verified, but this name became unavailable before the claim completed"
      : status === "reserved" ? "Desired label is reserved" : "Desired label is unavailable"
    throw conflictError(reason, handleAvailabilityDetails(status === "reserved" ? "reserved" : "taken", reason))
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

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
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
    await verifyPaymentForPaidHandleClaim({
      env: input.env,
      body: input.body,
      quoteId,
      priceCents,
      userWalletAttachments: await input.userRepository.getWalletAttachmentsByUserId(input.userId),
    })
  }
  const paymentVerified = priceCents > 0

  const writeDb = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
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
      throw conflictError(reason, handleAvailabilityDetails(blockingStatus === "reserved" ? "reserved" : "taken", reason))
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
