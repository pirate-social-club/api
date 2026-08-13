import { getAddress } from "ethers"

import type { Env } from "../../../env"
import { sha256Hex } from "../../crypto"
import { conflictError, eligibilityFailed } from "../../errors"
import { makeId } from "../../helpers"
import type { Client, QueryResultRow, Transaction } from "../../sql-client"
import { requiredString, rowValue } from "../../sql-row"
import { withTransaction } from "../../transactions"
import {
  consumeVerifiedAltchaChallenge,
  type AltchaProofInput,
  type VerifiedAltchaChallenge,
} from "../../verification/altcha-provider"
import {
  claimBuyerFundingReceiptForReview,
  claimVerifiedBuyerFundingReceipt,
  type BuyerFundingReceipt,
} from "../commerce/funding-proof-service"
import type { GatePolicy, GatePolicyEvaluation, GateTraceNode } from "../membership/gate-types"

export const HANDLE_CLAIM_AUTHORIZATION_SCOPE = "namespace_handle_claim" as const

export type HandleClaimIntentTerms = {
  actorUserId: string
  chainId?: number | null
  communityId: string
  custodyAccountId?: string | null
  custodyKeyEpoch?: string | null
  currency?: "USD"
  fundingDestinationAddress?: string | null
  labelDisplay: string
  labelNormalized: string
  latestQuoteId?: string | null
  namespaceId: string
  namespaceNormalizedLabel: string
  paymentNotAfter: string
  priceCents: number
  pricingModel?: string | null
  pricingTier?: string | null
  protocolIssuanceRequired?: boolean
  protocolOwnerScriptPubkeyHex?: string | null
  protocolOwnerWalletAttachmentId?: string | null
  settlementWalletAttachmentId?: string | null
  tokenAddress?: string | null
}

export type TokenEntitlementWitness = {
  chainNamespace: string
  contractAddress: string
  tokenId: string
}

export type FundHandleClaimIntentResult =
  | { status: "funded_pending_finalization" }
  | {
      reason: string
      status: "refund_pending"
    }

export type HandleClaimCustodyDisposition = {
  reason: string
  review: boolean
  additionalReceipts?: BuyerFundingReceipt[]
}

type SatisfiedAtomWitness = {
  gate_id: string
  gate_type: string
  provider: string | null
  token_keys?: string[]
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
}

export async function digestResolvedGatePolicy(policy: GatePolicy): Promise<string> {
  return await sha256Hex(stableJson(policy))
}

function satisfiedBranch(node: GateTraceNode): SatisfiedAtomWitness[] {
  if (!node.passed) return []
  if (node.kind === "gate") {
    if (!node.gate_id) throw conflictError("Satisfied gate trace is missing a stable gate id")
    return [{
      gate_id: node.gate_id,
      gate_type: node.gate_type,
      provider: node.provider ?? null,
      ...(node.token_keys?.length ? { token_keys: [...node.token_keys] } : {}),
    }]
  }
  const children = node.op === "or" ? node.children.filter((child) => child.passed).slice(0, 1) : node.children
  return children.flatMap(satisfiedBranch)
}

function normalizedAddress(value: string): string {
  return getAddress(value).toLowerCase()
}

export async function createHandleClaimIntent(input: {
  client: Client
  now: string
  terms: HandleClaimIntentTerms
}): Promise<string> {
  if (input.terms.latestQuoteId) {
    const existing = await findIntentByQuote(input.client, input.terms.communityId, input.terms.latestQuoteId)
    if (existing) return requiredString(existing, "community_handle_claim_intent_id")
  }
  const intentId = makeId("hci")
  try {
    await input.client.execute({
      sql: `
      INSERT INTO community_handle_claim_intents (
        community_handle_claim_intent_id, community_id, actor_user_id, namespace_id,
        namespace_normalized_label, label_normalized, label_display, status,
        price_cents, pricing_model, pricing_tier, settlement_wallet_attachment_id,
        protocol_owner_wallet_attachment_id, protocol_owner_script_pubkey_hex,
        protocol_issuance_required, currency, chain_id,
        token_address, funding_destination_address, custody_account_id,
        custody_key_epoch, latest_quote_id, payment_not_after, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'awaiting_authorization',
        ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
        ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?23
      )
    `,
      args: [
      intentId,
      input.terms.communityId,
      input.terms.actorUserId,
      input.terms.namespaceId,
      input.terms.namespaceNormalizedLabel,
      input.terms.labelNormalized,
      input.terms.labelDisplay,
      input.terms.priceCents,
      input.terms.pricingModel ?? null,
      input.terms.pricingTier ?? null,
      input.terms.settlementWalletAttachmentId ?? null,
      input.terms.protocolOwnerWalletAttachmentId ?? null,
      input.terms.protocolOwnerScriptPubkeyHex ?? null,
      input.terms.protocolIssuanceRequired ?? false,
      input.terms.currency ?? "USD",
      input.terms.chainId ?? null,
      input.terms.tokenAddress ? normalizedAddress(input.terms.tokenAddress) : null,
      input.terms.fundingDestinationAddress ? normalizedAddress(input.terms.fundingDestinationAddress) : null,
      input.terms.custodyAccountId ?? null,
      input.terms.custodyKeyEpoch ?? null,
      input.terms.latestQuoteId ?? null,
      input.terms.paymentNotAfter,
      input.now,
      ],
    })
  } catch (error) {
    if (input.terms.latestQuoteId) {
      const raced = await findIntentByQuote(input.client, input.terms.communityId, input.terms.latestQuoteId)
      if (raced) return requiredString(raced, "community_handle_claim_intent_id")
    }
    throw error
  }
  return intentId
}

export async function issueHandleClaimAuthorization(input: {
  altcha?: { proof: AltchaProofInput; verified: VerifiedAltchaChallenge }
  client: Client
  evaluation: GatePolicyEvaluation
  intentId: string
  now: string
  policy: GatePolicy
  policyRevision: number
  policySource: string
  tokenReservationExpiresAt?: string
}): Promise<string> {
  if (!input.evaluation.satisfied) throw eligibilityFailed("Handle claim gate is not satisfied")
  const atoms = satisfiedBranch(input.evaluation.trace)
  const tokenWitnesses = atoms.flatMap((atom) => atom.token_keys ?? []).map(parseTokenWitness)
  const requiresAltcha = atoms.some((atom) => atom.gate_type === "altcha_pow")
  if (requiresAltcha && !input.altcha) {
    throw conflictError("Satisfied ALTCHA gate is missing its verified challenge evidence")
  }
  const policyDigest = await digestResolvedGatePolicy(input.policy)
  const authorizationId = makeId("hcaa")
  await withTransaction(input.client, "write", async (tx) => {
    const intent = await requireIntent(tx, input.intentId)
    if (requiredString(intent, "status") === "authorized") {
      return
    }
    if (requiredString(intent, "status") !== "awaiting_authorization") {
      throw conflictError("Handle claim intent is not awaiting authorization")
    }
    const actorUserId = requiredString(intent, "actor_user_id")
    const paymentNotAfter = requiredString(intent, "payment_not_after")
    if (input.altcha) {
      if (
        input.altcha.proof.scope !== HANDLE_CLAIM_AUTHORIZATION_SCOPE
        || input.altcha.proof.action !== `handle-claim-intent:${input.intentId}`
      ) {
        throw conflictError("ALTCHA proof is not scoped to this handle claim intent")
      }
      const consumed = await consumeVerifiedAltchaChallenge({
        executor: tx,
        actorUserId,
        proof: input.altcha.proof,
        verified: input.altcha.verified,
      })
      if (!consumed) throw conflictError("ALTCHA proof was already consumed or is not bound to this intent")
    }
    await tx.execute({
      sql: `
        INSERT INTO community_handle_action_authorizations (
          community_handle_action_authorization_id, scope, actor_user_id,
          community_handle_claim_intent_id, community_id, namespace_id,
          label_normalized, policy_source, policy_revision, policy_digest,
          satisfied_branch_json, issued_at, payment_not_after, created_at
        ) VALUES (?1, 'namespace_handle_claim', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?11)
      `,
      args: [
        authorizationId,
        actorUserId,
        input.intentId,
        requiredString(intent, "community_id"),
        requiredString(intent, "namespace_id"),
        requiredString(intent, "label_normalized"),
        input.policySource,
        input.policyRevision,
        policyDigest,
        JSON.stringify(atoms),
        input.now,
        paymentNotAfter,
      ],
    })
    for (const witness of tokenWitnesses) {
      await reserveTokenWitness(tx, {
        authorizationId,
        intentId: input.intentId,
        namespaceId: requiredString(intent, "namespace_id"),
        expiresAt: input.tokenReservationExpiresAt ?? paymentNotAfter,
        reservedAt: input.now,
        witness,
      })
    }
    const updated = await tx.execute({
      sql: `
        UPDATE community_handle_claim_intents AS i
        SET status = 'authorized', action_authorization_id = ?2, updated_at = ?3
        WHERE community_handle_claim_intent_id = ?1 AND status = 'awaiting_authorization'
        RETURNING community_handle_claim_intent_id
      `,
      args: [input.intentId, authorizationId, input.now],
    })
    if (!updated.rows[0]) throw conflictError("Handle claim intent authorization raced")
  })
  const persisted = await requireIntent(input.client, input.intentId)
  return requiredString(persisted, "action_authorization_id")
}

async function findIntentByQuote(
  executor: Client | Transaction,
  communityId: string,
  quoteId: string,
): Promise<QueryResultRow | null> {
  const result = await executor.execute({
    sql: `
      SELECT * FROM community_handle_claim_intents
      WHERE community_id = ?1 AND latest_quote_id = ?2
      LIMIT 1
    `,
    args: [communityId, quoteId],
  })
  return result.rows[0] ?? null
}

function parseTokenWitness(tokenKey: string): TokenEntitlementWitness {
  const matched = /^(eip155:\d+):(0x[0-9a-fA-F]{40}):(.+)$/u.exec(tokenKey)
  if (!matched?.[1] || !matched[2] || !matched[3]) {
    throw conflictError("Satisfied inventory evidence contains an invalid token identity")
  }
  return {
    chainNamespace: matched[1],
    contractAddress: matched[2],
    tokenId: matched[3],
  }
}

export async function fundAuthorizedHandleClaimIntent(input: {
  authorizationId: string
  client: Client
  env: Env
  fallbackSenderAddress: string
  intentId: string
  now: string
  paymentClockSkewSeconds: number
  quoteId: string
  receipt: BuyerFundingReceipt
  custodyDisposition?: HandleClaimCustodyDisposition
  settlementWalletAttachmentId: string
}): Promise<FundHandleClaimIntentResult> {
  return await withTransaction(input.client, "write", async (tx) => {
    const intent = await requireIntent(tx, input.intentId)
    const currentStatus = requiredString(intent, "status")
    if (currentStatus === "funded_pending_finalization" || currentStatus === "refund_pending") {
      if (requiredString(intent, "funding_tx_hash").toLowerCase() !== input.receipt.txRef.toLowerCase()) {
        throw conflictError("Handle claim intent is already funded by a different transaction")
      }
      if (currentStatus === "refund_pending") {
        return { status: "refund_pending", reason: requiredString(intent, "refund_reason") }
      }
      return { status: "funded_pending_finalization" }
    }
    if (currentStatus !== "authorized") {
      throw conflictError("Handle claim intent is not authorized for funding")
    }
    if (requiredString(intent, "action_authorization_id") !== input.authorizationId) {
      throw conflictError("Handle claim authorization is not bound to this intent")
    }
    const receipt = input.custodyDisposition?.review
      ? await claimBuyerFundingReceiptForReview({
          client: tx,
          receipt: input.receipt,
          fallbackSenderAddress: input.fallbackSenderAddress,
          consumerRail: "community_handle_intent",
          consumerId: input.intentId,
          quoteId: input.quoteId,
          now: input.now,
        })
      : await claimVerifiedBuyerFundingReceipt({
          client: tx,
          receipt: input.receipt,
          fallbackSenderAddress: input.fallbackSenderAddress,
          consumerRail: "community_handle_intent",
          consumerId: input.intentId,
          quoteId: input.quoteId,
          now: input.now,
        })
    if (!receipt) throw conflictError("Funding receipt observation identity is missing")

    for (const [index, additionalReceipt] of (input.custodyDisposition?.additionalReceipts ?? []).entries()) {
      await claimBuyerFundingReceiptForReview({
        client: tx,
        receipt: additionalReceipt,
        fallbackSenderAddress: input.fallbackSenderAddress,
        consumerRail: "community_handle_intent",
        consumerId: `${input.intentId}:custody:${index + 1}`,
        quoteId: input.quoteId,
        now: input.now,
      })
    }

    const allocationState = await tx.execute({
      sql: `
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) AS reserved
        FROM community_handle_token_allocations
        WHERE community_handle_claim_intent_id = ?1
      `,
      args: [input.intentId],
    })
    const totalAllocations = Number(rowValue(allocationState.rows[0] ?? {}, "total") ?? 0)
    const reservedAllocations = Number(rowValue(allocationState.rows[0] ?? {}, "reserved") ?? 0)
    const includedAt = input.receipt.observation?.blockTimestamp
    const deadlineMs = Date.parse(requiredString(intent, "payment_not_after"))
    const includedMs = includedAt == null ? Number.NaN : includedAt * 1000
    const refundReason = input.custodyDisposition?.reason
      ?? (totalAllocations > reservedAllocations
      ? "token_entitlement_reservation_expired"
      : includedAt == null
      ? "funding_block_timestamp_missing"
      : !Number.isFinite(deadlineMs)
          || includedMs > deadlineMs + Math.max(0, input.paymentClockSkewSeconds) * 1000
        ? "funding_included_after_deadline"
        : null)
    const nextStatus = refundReason == null ? "funded_pending_finalization" : "refund_pending"

    const consumed = await tx.execute({
      sql: `
        UPDATE community_handle_action_authorizations
        SET consumed_at = ?3, consumed_by_intent_id = ?1
        WHERE community_handle_action_authorization_id = ?2
          AND community_handle_claim_intent_id = ?1
          AND consumed_at IS NULL
        RETURNING community_handle_action_authorization_id
      `,
      args: [input.intentId, input.authorizationId, input.now],
    })
    if (!consumed.rows[0]) throw conflictError("Handle claim authorization is already consumed")
    const updated = await tx.execute({
      sql: `
        UPDATE community_handle_claim_intents
        SET status = ?6, observed_funding_receipt_id = ?2,
            funding_tx_hash = ?3, funded_at = ?4,
            finalization_next_attempt_at = CASE WHEN ?6 = 'funded_pending_finalization' THEN ?4 ELSE NULL END,
            refund_pending_at = CASE WHEN ?6 = 'refund_pending' THEN ?4 ELSE NULL END,
            refund_reason = ?7,
            settlement_wallet_attachment_id = ?5,
            updated_at = ?4
        WHERE community_handle_claim_intent_id = ?1 AND status = 'authorized'
        RETURNING community_handle_claim_intent_id
      `,
      args: [
        input.intentId,
        receipt.id,
        receipt.txHash,
        input.now,
        input.settlementWalletAttachmentId,
        nextStatus,
        refundReason,
      ],
    })
    if (!updated.rows[0]) throw conflictError("Handle claim intent funding transition raced")
    return refundReason == null
      ? { status: "funded_pending_finalization" }
      : { status: "refund_pending", reason: refundReason }
  })
}

/**
 * Bind-then-classify transition for deterministic failures discovered after
 * the funding receipt has been claimed. The receipt is already durable at this
 * point; downstream shard or eligibility failures become a refund obligation,
 * never an untracked rejection.
 */
export async function markFundedHandleClaimIntentRefundPending(input: {
  client: Client
  intentId: string
  now: string
  reason: string
}): Promise<boolean> {
  return await withTransaction(input.client, "write", async (tx) => {
    const updated = await tx.execute({
      sql: `
        UPDATE community_handle_claim_intents
        SET status = 'refund_pending', refund_pending_at = ?2,
            refund_reason = ?3, finalization_next_attempt_at = NULL,
            finalization_attempt_count = finalization_attempt_count + 1,
            finalization_last_error = ?3, updated_at = ?2
        WHERE community_handle_claim_intent_id = ?1
          AND status = 'funded_pending_finalization'
        RETURNING community_handle_claim_intent_id
      `,
      args: [input.intentId, input.now, input.reason.slice(0, 1000)],
    })
    return updated.rows[0] != null
  })
}

export async function consumeAuthorizedFreeHandleClaimIntent(input: {
  actorUserId: string
  authorizationId: string
  client: Client
  communityId: string
  intentId: string
  now: string
  quoteId: string
}): Promise<void> {
  await withTransaction(input.client, "write", async (tx) => {
    const intent = await requireIntent(tx, input.intentId)
    if (
      requiredString(intent, "actor_user_id") !== input.actorUserId
      || requiredString(intent, "community_id") !== input.communityId
      || requiredString(intent, "latest_quote_id") !== input.quoteId
      || Number(rowValue(intent, "price_cents")) !== 0
    ) {
      throw conflictError("Free handle claim intent is not bound to this actor, quote, and target")
    }
    const status = requiredString(intent, "status")
    if (status === "completed") return
    if (status !== "authorized" || requiredString(intent, "action_authorization_id") !== input.authorizationId) {
      throw conflictError("Free handle claim intent is not authorized")
    }
    if (Date.parse(input.now) > Date.parse(requiredString(intent, "payment_not_after"))) {
      throw conflictError("Free handle claim authorization has expired")
    }
    const unavailableAllocation = await tx.execute({
      sql: `
        SELECT community_handle_token_allocation_id
        FROM community_handle_token_allocations
        WHERE community_handle_claim_intent_id = ?1 AND status != 'reserved'
        LIMIT 1
      `,
      args: [input.intentId],
    })
    if (unavailableAllocation.rows[0]) {
      throw conflictError("Free handle claim token entitlement is no longer reserved")
    }
    const consumed = await tx.execute({
      sql: `
        UPDATE community_handle_action_authorizations
        SET consumed_at = COALESCE(consumed_at, ?3), consumed_by_intent_id = ?1
        WHERE community_handle_action_authorization_id = ?2
          AND community_handle_claim_intent_id = ?1
          AND (consumed_at IS NULL OR consumed_by_intent_id = ?1)
        RETURNING community_handle_action_authorization_id
      `,
      args: [input.intentId, input.authorizationId, input.now],
    })
    if (!consumed.rows[0]) throw conflictError("Handle claim authorization is consumed by another intent")
  })
}

async function requireIntent(executor: Client | Transaction, intentId: string): Promise<QueryResultRow> {
  const result = await executor.execute({
    sql: "SELECT * FROM community_handle_claim_intents WHERE community_handle_claim_intent_id = ?1 LIMIT 1",
    args: [intentId],
  })
  if (!result.rows[0]) throw conflictError("Handle claim intent was not found")
  return result.rows[0]
}

export async function requireHandleClaimIntentBinding(input: {
  actorUserId: string
  client: Client | Transaction
  communityId: string
  intentId: string
  labelNormalized?: string | null
  namespaceId?: string | null
}): Promise<QueryResultRow> {
  const intent = await requireIntent(input.client, input.intentId)
  if (
    requiredString(intent, "actor_user_id") !== input.actorUserId
    || requiredString(intent, "community_id") !== input.communityId
    || (input.labelNormalized != null && requiredString(intent, "label_normalized") !== input.labelNormalized)
    || (input.namespaceId != null && requiredString(intent, "namespace_id") !== input.namespaceId)
  ) {
    throw conflictError("Handle claim intent is not bound to this actor and target")
  }
  return intent
}

export async function completeFundedHandleClaimIntent(input: {
  client: Client
  intentId: string
  now: string
}): Promise<void> {
  await withTransaction(input.client, "write", async (tx) => {
    const updated = await tx.execute({
      sql: `
        UPDATE community_handle_claim_intents AS i
        SET status = 'completed', completed_at = COALESCE(completed_at, ?2),
            finalization_attempt_count = CASE
              WHEN status = 'completed' THEN finalization_attempt_count
              ELSE finalization_attempt_count + 1
            END,
            finalization_last_error = NULL, finalization_next_attempt_at = NULL,
            updated_at = ?2
        WHERE community_handle_claim_intent_id = ?1
          AND (
            status IN ('funded_pending_finalization', 'completed')
            OR (
              status = 'authorized' AND price_cents = 0
              AND EXISTS (
                SELECT 1 FROM community_handle_action_authorizations a
                WHERE a.community_handle_action_authorization_id = i.action_authorization_id
                  AND a.consumed_by_intent_id = i.community_handle_claim_intent_id
                  AND a.consumed_at IS NOT NULL
              )
            )
          )
        RETURNING community_handle_claim_intent_id
      `,
      args: [input.intentId, input.now],
    })
    if (!updated.rows[0]) throw conflictError("Handle claim intent cannot be completed")
    await tx.execute({
      sql: `
        UPDATE community_handle_token_allocations
        SET status = 'consumed', consumed_at = COALESCE(consumed_at, ?2), updated_at = ?2
        WHERE community_handle_claim_intent_id = ?1 AND status IN ('reserved', 'consumed')
      `,
      args: [input.intentId, input.now],
    })
  })
}

async function reserveTokenWitness(executor: Transaction, input: {
  authorizationId: string
  intentId: string
  namespaceId: string
  expiresAt: string
  reservedAt: string
  witness: TokenEntitlementWitness
}): Promise<void> {
  await executor.execute({
    sql: `
      INSERT INTO community_handle_token_allocations (
        community_handle_token_allocation_id, community_handle_action_authorization_id,
        community_handle_claim_intent_id, namespace_id, chain_namespace,
        contract_address, token_id, status, reserved_at, expires_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'reserved', ?8, ?9, ?8, ?8)
    `,
    args: [
      makeId("hcta"), input.authorizationId, input.intentId, input.namespaceId,
      input.witness.chainNamespace, normalizedAddress(input.witness.contractAddress),
        input.witness.tokenId, input.reservedAt, input.expiresAt,
      ],
    })
}

export async function releaseExpiredHandleClaimTokenAllocations(input: {
  client: Client | Transaction
  now: string
}): Promise<number> {
  const released = await input.client.execute({
    sql: `
      UPDATE community_handle_token_allocations
      SET status = 'released', released_at = COALESCE(released_at, ?1), updated_at = ?1
      WHERE status = 'reserved' AND expires_at <= ?1
        AND EXISTS (
          SELECT 1 FROM community_handle_claim_intents i
          WHERE i.community_handle_claim_intent_id = community_handle_token_allocations.community_handle_claim_intent_id
            AND i.status IN ('awaiting_authorization', 'authorized')
        )
      RETURNING community_handle_token_allocation_id
    `,
    args: [input.now],
  })
  return released.rows.length
}

export function handleClaimIntentIdFromRow(row: QueryResultRow): string {
  return requiredString(row, "community_handle_claim_intent_id")
}

export function handleClaimIntentStatusFromRow(row: QueryResultRow): string {
  return String(rowValue(row, "status") ?? "")
}
