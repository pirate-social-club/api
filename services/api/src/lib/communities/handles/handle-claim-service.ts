import type {
  CommunityHandle,
  CommunityHandleClaimRequest,
  Env,
} from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { conflictError, badRequestError, eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import type { Client, QueryResultRow } from "../../sql-client"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../../sql-row"
import { withStandaloneControlPlaneClient } from "../../runtime-deps"
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
  serializeHandleQuote,
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
import { handleClaimIntentsEnabled } from "./handle-claim-intent-config"
import { claimCommunityHandleWithFundedIntent } from "./handle-funded-claim-service"
import {
  completeFundedHandleClaimIntent,
  consumeAuthorizedFreeHandleClaimIntent,
  requireHandleClaimIntentBinding,
} from "./handle-claim-intent-ledger"
import { attachHandleClaimIntentToQuote } from "./handle-claim-intent-quote"

async function completeFreeHandleClaimIntent(env: Env, intentId: string | null): Promise<void> {
  if (!intentId) return
  await withStandaloneControlPlaneClient(env, async (client) => {
    await completeFundedHandleClaimIntent({ client, intentId, now: nowIso() })
  })
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
  let consumedFreeIntentId: string | null = null
  if (handleClaimIntentsEnabled(input.env) && input.body.claim_intent?.trim()) {
    const intentId = input.body.claim_intent.trim()
    const authorizationId = input.body.action_authorization?.trim()
    if (!authorizationId) throw badRequestError("action_authorization is required for handle claim intents")
    const intent = await withStandaloneControlPlaneClient(input.env, async (client) => {
      return await requireHandleClaimIntentBinding({
        actorUserId: input.userId,
        client,
        communityId: input.communityId,
        intentId,
      })
    })
    if (requiredString(intent, "latest_quote_id") !== quoteId) {
      throw conflictError("Handle claim intent does not belong to this quote")
    }
    if ((numberOrNull(rowValue(intent, "price_cents")) ?? 0) > 0) {
      return await claimCommunityHandleWithFundedIntent({
        body: input.body,
        communityId: input.communityId,
        communityRepository: input.communityRepository,
        env: input.env,
        quoteId,
        userId: input.userId,
        userRepository: input.userRepository,
      })
    }
    await withStandaloneControlPlaneClient(input.env, async (client) => {
      await consumeAuthorizedFreeHandleClaimIntent({
        actorUserId: input.userId,
        authorizationId,
        client,
        communityId: input.communityId,
        intentId,
        now: nowIso(),
        quoteId,
      })
    })
    consumedFreeIntentId = intentId
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  let priceCents = 0
  let requiresProtocolIssuance = false
  let protocolOwner: { walletAttachmentId: string; scriptPubkeyHex: string } | null = null
  let adoptedFundedBody: CommunityHandleClaimRequest | null = null
  try {
    const quote = await getClaimQuote(db.client, {
      quoteId,
      communityId: input.communityId,
      userId: input.userId,
    })
    const existing = await getExistingHandleForQuote(db.client, quoteId)
    if (existing) {
      await completeFreeHandleClaimIntent(input.env, consumedFreeIntentId)
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
      skipGateEligibility: consumedFreeIntentId != null,
      env: input.env,
      userRepository: input.userRepository,
    })
    priceCents = checked.priceCents
    requiresProtocolIssuance = checked.protocolIssuanceRequired
    if (
      priceCents > 0
      && handleClaimIntentsEnabled(input.env)
      && !input.body.claim_intent?.trim()
    ) {
      if (!checked.gateEligibility) {
        throw internalError("Legacy paid handle quote gate eligibility was not evaluated")
      }
      if (requiresProtocolIssuance) {
        protocolOwner = await requireProtocolOwnerWalletForClaim({
          body: input.body,
          userId: input.userId,
          userRepository: input.userRepository,
        })
      }
      const attached = await attachHandleClaimIntentToQuote({
        communityId: input.communityId,
        env: input.env,
        gateEligibility: checked.gateEligibility,
        now: nowIso(),
        policy: checked.policy,
        protocolOwnerScriptPubkeyHex: protocolOwner?.scriptPubkeyHex ?? null,
        protocolOwnerWalletAttachmentId: protocolOwner?.walletAttachmentId ?? null,
        quote: serializeHandleQuote(quote, {
          env: input.env,
          availability: "available",
          desiredLabel: checked.labelDisplay,
          eligible: true,
          reason: null,
          protocolIssuanceEligible: !requiresProtocolIssuance || protocolOwner != null,
          protocolIssuanceRequired: requiresProtocolIssuance,
        }),
        quoteRow: quote,
        shardClient: db.client,
        userId: input.userId,
      })
      if (!attached.claim_intent || !attached.action_authorization) {
        throw internalError("Legacy paid handle quote adoption did not issue an authorization")
      }
      adoptedFundedBody = {
        ...input.body,
        claim_intent: attached.claim_intent,
        action_authorization: attached.action_authorization,
      }
    }
  } finally {
    db.close()
  }

  if (adoptedFundedBody) {
    return await claimCommunityHandleWithFundedIntent({
      body: adoptedFundedBody,
      communityId: input.communityId,
      communityRepository: input.communityRepository,
      env: input.env,
      quoteId,
      userId: input.userId,
      userRepository: input.userRepository,
    })
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
      await completeFreeHandleClaimIntent(input.env, consumedFreeIntentId)
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
      skipGateEligibility: consumedFreeIntentId != null,
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

    const handle = serializeHandle(await applyHandleClaimWrites(writeDb.client, {
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
      handleClaimIntentId: consumedFreeIntentId,
      now,
    }))
    await completeFreeHandleClaimIntent(input.env, consumedFreeIntentId)
    return handle
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
    handleClaimIntentId?: string | null
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
          handle_claim_intent_id, label_normalized, label_display, status, issuance_source, price_cents, currency,
          pricing_model, pricing_tier, settlement_wallet_attachment_id, protocol_owner_wallet_attachment_id, funding_tx_ref, settlement_tx_ref,
          lease_started_at, lease_expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, ?8, 'active', 'claim', ?9, 'USD',
          ?10, ?11, ?12, ?13, ?14, ?15,
          ?16, NULL, ?16, ?16
        )
      `,
      args: [
        handleId,
        input.communityId,
        input.userId,
        input.namespaceId,
        input.quoteId,
        input.handleClaimIntentId ?? null,
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
