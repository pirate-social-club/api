import type {
  CommunityHandle,
  CommunityHandleClaimRequest,
  Env,
} from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { conflictError, badRequestError, eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import type { Client, QueryResultRow } from "../../sql-client"
import { requiredString, rowValue, stringOrNull } from "../../sql-row"
import { openCommunityWriteClient } from "../community-read-access"
import type { HandleCommunityRepository } from "./handle-policy-service"
import {
  HANDLE_PROTOCOL_ISSUANCE_JOIN,
  HANDLE_PROTOCOL_ISSUANCE_SELECT,
  getBlockingHandleForLabel,
  serializeHandle,
} from "./handle-row-store"
import {
  addHandleQuoteSeconds,
  handleAvailabilityDetails,
} from "./handle-quote-domain"
import {
  acquireHandleLabelReservation,
  consumeHandleLabelReservation,
} from "./handle-label-reservation"
import {
  createProtocolIssuanceForHandle,
  requireProtocolOwnerWalletForClaim,
} from "./handle-protocol-issuance"
import { verifyPaymentForPaidHandleClaim } from "./handle-payment-verification"
import {
  assertClaimQuoteStillClaimable,
  getClaimQuote,
  getExistingHandleForQuote,
} from "./handle-claim-validation"

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
      env: input.env,
      userRepository: input.userRepository,
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
      communityId: input.communityId,
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
      env: input.env,
      userRepository: input.userRepository,
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
  let transientReservationId: string | null = null
  try {
    if (input.priceCents > 0) {
      await consumeHandleLabelReservation({
        executor: tx,
        quoteId: input.quoteId,
        now: input.now,
      })
    } else {
      transientReservationId = await acquireHandleLabelReservation({
        executor: tx,
        communityId: input.communityId,
        namespaceId: input.namespaceId,
        labelNormalized: input.labelNormalized,
        userId: input.userId,
        quoteId: null,
        purpose: "claim",
        reservedAt: input.now,
        expiresAt: addHandleQuoteSeconds(input.now, 60),
      })
    }

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

    if (transientReservationId) {
      await consumeHandleLabelReservation({
        executor: tx,
        reservationId: transientReservationId,
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
