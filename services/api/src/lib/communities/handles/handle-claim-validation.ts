import type { DbExecutor } from "../../db-helpers"
import type { Env } from "../../../env"
import type { UserRepository } from "../../auth/repositories"
import { conflictError, eligibilityFailed, notFoundError } from "../../errors"
import type { Client, QueryResultRow, Transaction } from "../../sql-client"
import { requiredNumber, requiredString } from "../../sql-row"
import { requireHandleClaimAccess, requireNamespaceHandleClaimEligibility } from "./handle-access"
import {
  type NamespacePolicyRow,
  getNamespacePolicy,
  parseHandleClaimSettings,
} from "./handle-policy-service"
import { requireProtocolIssuanceSupport } from "./handle-protocol-issuance"
import { type HandleAvailability, handleAvailabilityDetails, isReservedHandleLabel } from "./handle-quote-domain"
import {
  HANDLE_PROTOCOL_ISSUANCE_JOIN,
  HANDLE_PROTOCOL_ISSUANCE_SELECT,
  getActiveHandleForUser,
  getBlockingHandleForLabel,
} from "./handle-row-store"
import {
  expireStaleHandleLabelReservations,
  getActiveHandleLabelReservationForQuote,
} from "./handle-label-reservation"

export async function expireStaleHandleQuotes(input: {
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
  await expireStaleHandleLabelReservations({
    executor: input.executor,
    communityId: input.communityId,
    now: input.now,
  })
}

export async function getExistingHandleForQuote(executor: DbExecutor, quoteId: string): Promise<QueryResultRow | null> {
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

export async function getClaimQuote(
  executor: DbExecutor,
  input: { quoteId: string; communityId: string; userId: string },
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

export async function assertClaimQuoteStillClaimable(input: {
  executor: Client | Transaction
  communityId: string
  userId: string
  quoteId: string
  quote: QueryResultRow
  now: string
  paymentVerified: boolean
  env: Env
  userRepository: UserRepository
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

  const policy = await getNamespacePolicy(input.executor, input.communityId, {
    namespaceId: requiredString(input.quote, "namespace_id"),
  })
  if (!policy || policy.namespace_id !== requiredString(input.quote, "namespace_id")) {
    throw eligibilityFailed("Community names are not available for this community")
  }
  if (!policy.claims_enabled) {
    throw eligibilityFailed("Community name claims are currently disabled")
  }
  const settings = parseHandleClaimSettings(policy.settings_json)
  await requireHandleClaimAccess({ client: input.executor, communityId: input.communityId, userId: input.userId })
  await requireNamespaceHandleClaimEligibility({
    env: input.env,
    client: input.executor,
    communityId: input.communityId,
    userId: input.userId,
    userRepository: input.userRepository,
    policy,
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
    const availability: HandleAvailability = activeLabel === labelNormalized ? "already_claimed_by_viewer" : "viewer_has_claim"
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

  const priceCents = requiredNumber(input.quote, "price_cents")
  if (priceCents > 0) {
    const paymentReservation = await getActiveHandleLabelReservationForQuote({
      executor: input.executor,
      quoteId: input.quoteId,
    })
    if (!paymentReservation
      || requiredString(paymentReservation, "namespace_id") !== policy.namespace_id
      || requiredString(paymentReservation, "label_normalized") !== labelNormalized
      || Date.parse(requiredString(paymentReservation, "expires_at")) <= Date.parse(input.now)) {
      throw eligibilityFailed("Payment reservation is no longer active; request a new quote")
    }
  }

  return {
    policy,
    labelNormalized,
    labelDisplay,
    priceCents,
    protocolIssuanceRequired: requireProtocolIssuanceSupport(policy, settings),
  }
}
