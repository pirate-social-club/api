import type { CommunityHandleQuote, Env } from "../../../types"
import { conflictError } from "../../errors"
import { withStandaloneControlPlaneClient } from "../../runtime-deps"
import type { Client, QueryResultRow } from "../../sql-client"
import { requiredString, rowValue, stringOrNull } from "../../sql-row"
import type { AltchaProofInput, VerifiedAltchaChallenge } from "../../verification/altcha-provider"
import { assertPirateCheckoutRefundReadiness } from "../commerce/checkout-config"
import type { GatePolicy, GatePolicyEvaluation } from "../membership/gate-types"
import type { HandleClaimEligibility } from "./handle-access"
import {
  handleClaimIntentsEnabled,
  resolveHandleClaimAuthorizationReleaseGraceSeconds,
} from "./handle-claim-intent-config"
import {
  createHandleClaimIntent,
  issueHandleClaimAuthorization,
} from "./handle-claim-intent-ledger"
import { bindHandleQuoteToClaimIntent } from "./handle-label-reservation"
import type { NamespacePolicyRow } from "./handle-policy-service"

const ALLOW_POLICY: GatePolicy = {
  version: 1,
  expression: { op: "and", children: [] },
}

const ALLOW_EVALUATION: GatePolicyEvaluation = {
  satisfied: true,
  outcome: "passed",
  trace: { kind: "op", op: "and", passed: true, children: [] },
  requiredActionSet: null,
}

export async function attachHandleClaimIntentToQuote(input: {
  altcha?: { proof: AltchaProofInput; verified: VerifiedAltchaChallenge }
  communityId: string
  env: Env
  gateEligibility: HandleClaimEligibility
  now: string
  policy: NamespacePolicyRow
  protocolOwnerScriptPubkeyHex?: string | null
  protocolOwnerWalletAttachmentId?: string | null
  quote: CommunityHandleQuote
  quoteRow: QueryResultRow
  requestedIntentId?: string | null
  shardClient: Client
  userId: string
}): Promise<CommunityHandleQuote> {
  if (!handleClaimIntentsEnabled(input.env)) return input.quote

  const quoteId = requiredString(input.quoteRow, "handle_claim_quote_id")
  const rowIntentId = stringOrNull(rowValue(input.quoteRow, "handle_claim_intent_id"))
  if (input.requestedIntentId && rowIntentId && input.requestedIntentId !== rowIntentId) {
    throw conflictError("Handle claim intent does not belong to this quote")
  }

  const readiness = input.quote.price_cents > 0 ? assertPirateCheckoutRefundReadiness(input.env) : null
  const paymentNotAfter = requiredString(input.quoteRow, "expires_at")
  const intentId = await withStandaloneControlPlaneClient(input.env, async (client) => {
    const created = await createHandleClaimIntent({
      client,
      now: input.now,
      terms: {
        actorUserId: input.userId,
        chainId: readiness?.chainId ?? null,
        communityId: input.communityId,
        custodyAccountId: readiness?.custodyAccountId ?? null,
        custodyKeyEpoch: readiness?.custodyKeyEpoch ?? null,
        fundingDestinationAddress: readiness?.operatorAddress ?? null,
        labelDisplay: requiredString(input.quoteRow, "label_display"),
        labelNormalized: requiredString(input.quoteRow, "label_normalized"),
        latestQuoteId: quoteId,
        namespaceId: input.policy.namespace_id,
        namespaceNormalizedLabel: input.policy.normalized_label,
        paymentNotAfter,
        priceCents: input.quote.price_cents,
        pricingModel: stringOrNull(rowValue(input.quoteRow, "pricing_model")),
        pricingTier: stringOrNull(rowValue(input.quoteRow, "pricing_tier")),
        protocolIssuanceRequired: input.quote.protocol_issuance_required,
        protocolOwnerScriptPubkeyHex: input.protocolOwnerScriptPubkeyHex,
        protocolOwnerWalletAttachmentId: input.protocolOwnerWalletAttachmentId,
        tokenAddress: readiness?.tokenAddress ?? null,
      },
    })
    if (input.requestedIntentId && created !== input.requestedIntentId) {
      throw conflictError("Handle claim intent does not belong to this quote")
    }
    return created
  })

  const reservable = input.gateEligibility.satisfied
    && input.quote.availability === "available"
    && input.quote.protocol_issuance_eligible
  await bindHandleQuoteToClaimIntent({
    client: input.shardClient,
    communityId: input.communityId,
    expiresAt: paymentNotAfter,
    intentId,
    labelNormalized: requiredString(input.quoteRow, "label_normalized"),
    namespaceId: input.policy.namespace_id,
    now: input.now,
    quoteId,
    reserveForPayment: reservable && input.quote.price_cents > 0,
    userId: input.userId,
  })

  let authorizationId: string | null = null
  if (reservable) {
    authorizationId = await withStandaloneControlPlaneClient(input.env, async (client) => {
      return await issueHandleClaimAuthorization({
        ...(input.altcha ? { altcha: input.altcha } : {}),
        client,
        evaluation: input.gateEligibility.evaluation ?? ALLOW_EVALUATION,
        intentId,
        now: input.now,
        policy: input.gateEligibility.gate?.policy ?? ALLOW_POLICY,
        policyRevision: input.policy.revision,
        policySource: input.gateEligibility.gate?.source ?? "none",
        tokenReservationExpiresAt: new Date(
          Date.parse(paymentNotAfter)
            + resolveHandleClaimAuthorizationReleaseGraceSeconds(input.env) * 1000,
        ).toISOString(),
      })
    })
  }

  return {
    ...input.quote,
    claim_intent: intentId,
    action_authorization: authorizationId,
  }
}
