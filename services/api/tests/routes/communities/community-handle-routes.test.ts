import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import {
  resolvePirateCheckoutOperatorAddress,
  resolvePirateCheckoutUsdcTokenAddress,
} from "../../../src/lib/communities/commerce/checkout-config"
import { setCommunityCommerceBuyerFundingVerifierForTests } from "../../../src/lib/communities/commerce/funding-proof-service"
import { badRequestError } from "../../../src/lib/errors"
import type { Env } from "../../../src/types"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "../../helpers"
import {
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function rawCommunityId(value: string): string {
  return value.replace(/^com_/, "")
}

function rawHandleQuoteId(value: string): string {
  return value.startsWith("hcq_hcq_") ? value.slice("hcq_".length) : value
}

async function createNamespaceBackedCommunity(input: {
  accessToken: string
  env: Env
  namespaceVerification: string
}): Promise<string> {
  const created = await requestJson("http://pirate.test/communities", {
    display_name: "Country Handle Club",
    membership_mode: "request",
    handle_policy: { policy_template: "standard", pricing_model: "free" },
    namespace: {
      namespace_verification: input.namespaceVerification,
    },
  }, input.env, input.accessToken)
  expect(created.status).toBe(202)
  const body = await json(created) as { community: { id: string } }
  return rawCommunityId(body.community.id)
}

async function exchangeJwtWithWallet(env: Env, sub: string): Promise<{
  accessToken: string
  userId: string
  primaryWalletAttachment: string
}> {
  const upstreamJwt = await mintUpstreamJwt(env, {
    sub,
    wallet_address: "0x1000000000000000000000000000000000000001",
  })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt: upstreamJwt,
    },
  }, env)
  expect(response.status).toBe(200)
  const body = await json(response) as {
    access_token: string
    user: {
      id: string
      primary_wallet_attachment: string
    }
  }
  return {
    accessToken: body.access_token,
    userId: body.user.id.replace(/^usr_/, ""),
    primaryWalletAttachment: body.user.primary_wallet_attachment,
  }
}

async function updateLocalNamespaceHandlePolicySettings(input: {
  communityDbRoot: string
  communityId: string
  settingsJson: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    await client.execute({
      sql: `
        UPDATE namespace_handle_policies
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.settingsJson, new Date().toISOString()],
    })
  } finally {
    client.close()
  }
}

async function markLocalCommunityMemberLeft(input: {
  communityDbRoot: string
  communityId: string
  userId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        UPDATE community_memberships
        SET status = 'left',
            left_at = ?3,
            updated_at = ?3
        WHERE community_id = ?1
          AND user_id = ?2
      `,
      args: [input.communityId, input.userId, now],
    })
  } finally {
    client.close()
  }
}

async function updateLocalHandleQuoteExpiration(input: {
  communityDbRoot: string
  communityId: string
  quoteId: string
  expiresAt: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    await client.execute({
      sql: `
        UPDATE community_handle_claim_quotes
        SET expires_at = ?2,
            updated_at = ?3
        WHERE handle_claim_quote_id = ?1
      `,
      args: [rawHandleQuoteId(input.quoteId), input.expiresAt, new Date().toISOString()],
    })
  } finally {
    client.close()
  }
}

async function getLocalHandleQuoteStatus(input: {
  communityDbRoot: string
  communityId: string
  quoteId: string
}): Promise<string | null> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT status
        FROM community_handle_claim_quotes
        WHERE handle_claim_quote_id = ?1
        LIMIT 1
      `,
      args: [rawHandleQuoteId(input.quoteId)],
    })
    const value = result.rows[0]?.status
    return typeof value === "string" ? value : null
  } finally {
    client.close()
  }
}

async function countLocalHandleQuotes(input: {
  communityDbRoot: string
  communityId: string
  labelNormalized: string
}): Promise<number> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM community_handle_claim_quotes
        WHERE community_id = ?1
          AND label_normalized = ?2
      `,
      args: [input.communityId, input.labelNormalized],
    })
    return Number(result.rows[0]?.count ?? 0)
  } finally {
    client.close()
  }
}

describe("community handle routes", () => {
  test("member can quote and claim a free namespace handle", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-handle-free-creator")
    const namespaceVerification = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityId = await createNamespaceBackedCommunity({
      accessToken: creator.accessToken,
      env: ctx.env,
      namespaceVerification,
    })

    const emptyHandleResponse = await app.request(
      `http://pirate.test/communities/${communityId}/handles/me`,
      {
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(emptyHandleResponse.status).toBe(200)
    expect(await json(emptyHandleResponse)).toEqual({ handle: null })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "amara" },
      ctx.env,
      creator.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quote = await json(quoteResponse) as {
      id: string
      object: string
      community: string
      label: string
      label_normalized: string
      eligible: boolean
      availability: string
      price_cents: number
    }
    expect(quote.object).toBe("community_handle_quote")
    expect(quote.community).toBe(`com_${communityId}`)
    expect(quote.label).toBe("amara")
    expect(quote.label_normalized).toBe("amara")
    expect(quote.eligible).toBe(true)
    expect(quote.availability).toBe("available")
    expect(quote.price_cents).toBe(0)

    const repeatedQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "amara" },
      ctx.env,
      creator.accessToken,
    )
    expect(repeatedQuoteResponse.status).toBe(200)
    const repeatedQuote = await json(repeatedQuoteResponse) as { id: string }
    expect(repeatedQuote.id).toBe(quote.id)
    expect(await countLocalHandleQuotes({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      labelNormalized: "amara",
    })).toBe(1)

    const claimResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      { quote: quote.id },
      ctx.env,
      creator.accessToken,
    )
    expect(claimResponse.status).toBe(200)
    const claim = await json(claimResponse) as {
      object: string
      community: string
      label: string
      label_normalized: string
      status: string
      price_cents: number
    }
    expect(claim.object).toBe("community_handle")
    expect(claim.community).toBe(`com_${communityId}`)
    expect(claim.label).toBe("amara")
    expect(claim.label_normalized).toBe("amara")
    expect(claim.status).toBe("active")
    expect(claim.price_cents).toBe(0)

    const myHandleResponse = await app.request(
      `http://pirate.test/communities/${communityId}/handles/me`,
      {
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(myHandleResponse.status).toBe(200)
    const myHandle = await json(myHandleResponse) as { handle: { label: string; status: string } | null }
    expect(myHandle.handle?.label).toBe("amara")
    expect(myHandle.handle?.status).toBe("active")

    const duplicateQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "amara" },
      ctx.env,
      creator.accessToken,
    )
    expect(duplicateQuoteResponse.status).toBe(200)
    const duplicateQuote = await json(duplicateQuoteResponse) as {
      eligible: boolean
      availability: string
      reason: string | null
    }
    expect(duplicateQuote.eligible).toBe(false)
    expect(duplicateQuote.availability).toBe("already_claimed_by_viewer")

    const secondLabelQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "nina" },
      ctx.env,
      creator.accessToken,
    )
    expect(secondLabelQuoteResponse.status).toBe(200)
    const secondLabelQuote = await json(secondLabelQuoteResponse) as {
      id: string
      eligible: boolean
      availability: string
      reason: string | null
    }
    expect(secondLabelQuote.eligible).toBe(false)
    expect(secondLabelQuote.availability).toBe("viewer_has_claim")

    const secondLabelClaimResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      { quote: secondLabelQuote.id },
      ctx.env,
      creator.accessToken,
    )
    expect(secondLabelClaimResponse.status).toBe(409)
    const secondLabelClaimError = await json(secondLabelClaimResponse) as {
      code: string
      details: { availability: string; reason: string }
    }
    expect(secondLabelClaimError.code).toBe("conflict")
    expect(secondLabelClaimError.details.availability).toBe("viewer_has_claim")
    expect(secondLabelClaimError.details.reason).toBe("You already have an active name in this community")

    await markLocalCommunityMemberLeft({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: creator.userId,
    })
    const leftMemberHandleResponse = await app.request(
      `http://pirate.test/communities/${communityId}/handles/me`,
      {
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(leftMemberHandleResponse.status).toBe(200)
    const leftMemberHandle = await json(leftMemberHandleResponse) as { handle: { label: string; status: string } | null }
    expect(leftMemberHandle.handle?.label).toBe("amara")
    expect(leftMemberHandle.handle?.status).toBe("active")
  })

  test("malformed handle policy settings fail closed", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-handle-malformed-settings-creator")
    const namespaceVerification = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityId = await createNamespaceBackedCommunity({
      accessToken: creator.accessToken,
      env: ctx.env,
      namespaceVerification,
    })
    await updateLocalNamespaceHandlePolicySettings({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      settingsJson: "{",
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "amara" },
      ctx.env,
      creator.accessToken,
    )
    expect(quoteResponse.status).toBe(500)
    const quoteError = await json(quoteResponse) as {
      code: string
      details: { reason: string }
    }
    expect(quoteError.code).toBe("internal_error")
    expect(quoteError.details.reason).toBe("invalid_settings_json")
  })

  test("handle quote validation rejects reserved labels, short labels, non-members, and expired quotes", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-handle-validation-creator")
    const namespaceVerification = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityId = await createNamespaceBackedCommunity({
      accessToken: creator.accessToken,
      env: ctx.env,
      namespaceVerification,
    })

    const shortQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "ab" },
      ctx.env,
      creator.accessToken,
    )
    expect(shortQuoteResponse.status).toBe(400)
    const shortQuoteError = await json(shortQuoteResponse) as { code: string; message: string }
    expect(shortQuoteError.code).toBe("bad_request")
    expect(shortQuoteError.message).toBe("desired_label must be at least 3 characters")

    const nonMember = await exchangeJwt(ctx.env, "community-handle-validation-non-member")
    const nonMemberQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "sana" },
      ctx.env,
      nonMember.accessToken,
    )
    expect(nonMemberQuoteResponse.status).toBe(403)
    const nonMemberQuoteError = await json(nonMemberQuoteResponse) as { code: string; message: string }
    expect(nonMemberQuoteError.code).toBe("eligibility_failed")
    expect(nonMemberQuoteError.message).toBe("Community membership is required to claim names")

    const reservedQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "admin" },
      ctx.env,
      creator.accessToken,
    )
    expect(reservedQuoteResponse.status).toBe(200)
    const reservedQuote = await json(reservedQuoteResponse) as {
      id: string
      eligible: boolean
      availability: string
      reason: string | null
    }
    expect(reservedQuote.eligible).toBe(false)
    expect(reservedQuote.availability).toBe("reserved")
    expect(reservedQuote.reason).toBe("Desired label is reserved")

    const reservedClaimResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      { quote: reservedQuote.id },
      ctx.env,
      creator.accessToken,
    )
    expect(reservedClaimResponse.status).toBe(403)
    const reservedClaimError = await json(reservedClaimResponse) as {
      code: string
      details: { availability: string; reason: string }
    }
    expect(reservedClaimError.code).toBe("eligibility_failed")
    expect(reservedClaimError.details.availability).toBe("reserved")

    const expiringQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "sana" },
      ctx.env,
      creator.accessToken,
    )
    expect(expiringQuoteResponse.status).toBe(200)
    const expiringQuote = await json(expiringQuoteResponse) as { id: string }
    await updateLocalHandleQuoteExpiration({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      quoteId: expiringQuote.id,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })

    const expiredClaimResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      { quote: expiringQuote.id },
      ctx.env,
      creator.accessToken,
    )
    expect(expiredClaimResponse.status).toBe(403)
    const expiredClaimError = await json(expiredClaimResponse) as { code: string; message: string }
    expect(expiredClaimError.code).toBe("eligibility_failed")
    expect(expiredClaimError.message).toBe("Handle quote has expired")
    expect(await getLocalHandleQuoteStatus({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      quoteId: expiringQuote.id,
    })).toBe("expired")
  })

  test("community owner can list, reserve, and revoke namespace handles", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-handle-admin-creator")
    const namespaceVerification = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityId = await createNamespaceBackedCommunity({
      accessToken: creator.accessToken,
      env: ctx.env,
      namespaceVerification,
    })

    const reserveResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/reserve`,
      { desired_label: "crown" },
      ctx.env,
      creator.accessToken,
    )
    expect(reserveResponse.status).toBe(200)
    const reserved = await json(reserveResponse) as {
      id: string
      label: string
      status: string
      issuance_source: string
      pricing_tier: string
    }
    expect(reserved.label).toBe("crown")
    expect(reserved.status).toBe("reserved")
    expect(reserved.issuance_source).toBe("admin_grant")
    expect(reserved.pricing_tier).toBe("reserved")

    const reservedQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "crown" },
      ctx.env,
      creator.accessToken,
    )
    expect(reservedQuoteResponse.status).toBe(200)
    const reservedQuote = await json(reservedQuoteResponse) as {
      eligible: boolean
      availability: string
      reason: string | null
    }
    expect(reservedQuote.eligible).toBe(false)
    expect(reservedQuote.availability).toBe("reserved")
    expect(reservedQuote.reason).toBe("Desired label is reserved")

    const listResponse = await app.request(
      `http://pirate.test/communities/${communityId}/handles?status=reserved`,
      {
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(listResponse.status).toBe(200)
    const list = await json(listResponse) as { handles: Array<{ id: string; label: string; status: string }> }
    expect(list.handles.length).toBe(1)
    expect(list.handles[0]?.id).toBe(reserved.id)
    expect(list.handles[0]?.label).toBe("crown")
    expect(list.handles[0]?.status).toBe("reserved")

    const revokeResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/${reserved.id}/revoke`,
      { reason: "release for launch smoke" },
      ctx.env,
      creator.accessToken,
    )
    expect(revokeResponse.status).toBe(200)
    const revoked = await json(revokeResponse) as { id: string; label: string; status: string }
    expect(revoked.id).toBe(reserved.id)
    expect(revoked.label).toBe("crown")
    expect(revoked.status).toBe("revoked")

    const releasedQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "crown" },
      ctx.env,
      creator.accessToken,
    )
    expect(releasedQuoteResponse.status).toBe(200)
    const releasedQuote = await json(releasedQuoteResponse) as {
      eligible: boolean
      availability: string
    }
    expect(releasedQuote.eligible).toBe(true)
    expect(releasedQuote.availability).toBe("available")
  })

  test("paid handle claim requires wallet and funding proof", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwtWithWallet(ctx.env, "community-handle-paid-creator")
    const namespaceVerification = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityId = await createNamespaceBackedCommunity({
      accessToken: creator.accessToken,
      env: ctx.env,
      namespaceVerification,
    })

    const policyResponse = await app.request(
      `http://pirate.test/communities/${communityId}/handle-policy`,
      {
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(policyResponse.status).toBe(200)
    const policy = await json(policyResponse) as {
      community: string
      namespace: string
      policy_template: string
      membership_required_for_claim: boolean
      settings: Record<string, unknown>
    }
    expect(policy.community).toBe(`com_${communityId}`)
    expect(policy.namespace.startsWith("ns_")).toBe(true)
    expect(policy.policy_template).toBe("standard")
    expect(policy.membership_required_for_claim).toBe(true)
    expect(policy.settings).toEqual({})

    const updatePolicyResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handle-policy`,
      {
        pricing_model: "flat_by_length",
        settings: {
          flat_price_cents: 500,
          premium_price_cents: 2500,
          premium_max_length: 4,
          quote_ttl_seconds: 600,
        },
      },
      ctx.env,
      creator.accessToken,
    )
    expect(updatePolicyResponse.status).toBe(200)
    const updatedPolicy = await json(updatePolicyResponse) as {
      pricing_model: string
      settings: {
        flat_price_cents: number
        premium_price_cents: number
        premium_max_length: number
        quote_ttl_seconds: number
      }
    }
    expect(updatedPolicy.pricing_model).toBe("flat_by_length")
    expect(updatedPolicy.settings.flat_price_cents).toBe(500)
    expect(updatedPolicy.settings.premium_price_cents).toBe(2500)
    expect(updatedPolicy.settings.premium_max_length).toBe(4)
    expect(updatedPolicy.settings.quote_ttl_seconds).toBe(600)

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "longname" },
      ctx.env,
      creator.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quote = await json(quoteResponse) as {
      id: string
      eligible: boolean
      price_cents: number
      pricing_tier: string
      payment_instructions: {
        chain: {
          chain_namespace: string
          chain_id: number
          display_name: string
        }
        token_address: string
        recipient_address: string
        amount_atomic: string
        amount_display: string
      } | null
    }
    expect(quote.eligible).toBe(true)
    expect(quote.price_cents).toBe(500)
    expect(quote.pricing_tier).toBe("standard")
    expect(quote.payment_instructions).toEqual({
      chain: {
        chain_namespace: "eip155",
        chain_id: 84532,
        display_name: "Base Sepolia",
      },
      token_address: resolvePirateCheckoutUsdcTokenAddress(ctx.env),
      recipient_address: resolvePirateCheckoutOperatorAddress(ctx.env),
      amount_atomic: "5000000",
      amount_display: "5.00",
    })

    const claimResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      { quote: quote.id },
      ctx.env,
      creator.accessToken,
    )
    expect(claimResponse.status).toBe(400)
    const claimError = await json(claimResponse) as { code: string; message: string }
    expect(claimError.code).toBe("bad_request")
    expect(claimError.message).toBe("settlement_wallet_attachment is required for paid handle claims")

    setCommunityCommerceBuyerFundingVerifierForTests(async () => {
      throw badRequestError("Funding transaction did not deliver enough USDC to the checkout operator")
    })
    const fakeFundingResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      {
        quote: quote.id,
        settlement_wallet_attachment: creator.primaryWalletAttachment,
        funding_tx_ref: "0xfake",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(fakeFundingResponse.status).toBe(400)
    const fakeFundingError = await json(fakeFundingResponse) as { code: string; message: string }
    expect(fakeFundingError.code).toBe("bad_request")
    expect(fakeFundingError.message).toBe("Funding transaction did not deliver enough USDC to the checkout operator")

    setCommunityCommerceBuyerFundingVerifierForTests(async (input) => ({
      txRef: input.fundingTxRef,
      fromAddress: input.buyerAddress,
      toAddress: input.quote.funding_destination_address ?? "0x5000000000000000000000000000000000000005",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: String(BigInt(Math.round(input.quote.final_price_usd * 1_000_000))),
      chainRef: "eip155:84532",
    }))
    const paidClaimResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      {
        quote: quote.id,
        settlement_wallet_attachment: creator.primaryWalletAttachment,
        funding_tx_ref: "0xfunded",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(paidClaimResponse.status).toBe(200)
    const paidClaim = await json(paidClaimResponse) as {
      label: string
      price_cents: number
      funding_tx_ref: string
    }
    expect(paidClaim.label).toBe("longname")
    expect(paidClaim.price_cents).toBe(500)
    expect(paidClaim.funding_tx_ref).toBe("0xfunded")
  })

  test("claims_enabled blocks quote and claim but preserves /handles/me for existing owners", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-handle-claims-enabled-creator")
    const namespaceVerification = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityId = await createNamespaceBackedCommunity({
      accessToken: creator.accessToken,
      env: ctx.env,
      namespaceVerification,
    })

    // Claim a handle while claims are enabled (default)
    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "enabled" },
      ctx.env,
      creator.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quote = await json(quoteResponse) as { id: string }

    const claimResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      { quote: quote.id },
      ctx.env,
      creator.accessToken,
    )
    expect(claimResponse.status).toBe(200)

    // Disable claims
    const disableResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handle-policy`,
      { claims_enabled: false },
      ctx.env,
      creator.accessToken,
    )
    expect(disableResponse.status).toBe(200)
    const disabledPolicy = await json(disableResponse) as { claims_enabled: boolean }
    expect(disabledPolicy.claims_enabled).toBe(false)

    // Quote should fail with eligibility error
    const blockedQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "blocked" },
      ctx.env,
      creator.accessToken,
    )
    expect(blockedQuoteResponse.status).toBe(403)
    const blockedQuoteError = await json(blockedQuoteResponse) as { code: string; message: string }
    expect(blockedQuoteError.code).toBe("eligibility_failed")
    expect(blockedQuoteError.message).toBe("Community name claims are currently disabled")

    // /handles/me should still return the existing handle
    const myHandleResponse = await app.request(
      `http://pirate.test/communities/${communityId}/handles/me`,
      {
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(myHandleResponse.status).toBe(200)
    const myHandle = await json(myHandleResponse) as { handle: { label: string; status: string } | null }
    expect(myHandle.handle?.label).toBe("enabled")
    expect(myHandle.handle?.status).toBe("active")

    // Re-enable claims
    const enableResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handle-policy`,
      { claims_enabled: true },
      ctx.env,
      creator.accessToken,
    )
    expect(enableResponse.status).toBe(200)
    const enabledPolicy = await json(enableResponse) as { claims_enabled: boolean }
    expect(enabledPolicy.claims_enabled).toBe(true)

    // Quote should work again (not blocked by claims disabled)
    const reenabledQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "reenabled" },
      ctx.env,
      creator.accessToken,
    )
    expect(reenabledQuoteResponse.status).toBe(200)
    const reenabledQuote = await json(reenabledQuoteResponse) as { eligible: boolean; availability: string; reason?: string | null }
    // Creator already has a handle, so this returns viewer_has_claim — the important thing
    // is that it is NOT the "claims are currently disabled" error.
    expect(reenabledQuote.availability).not.toBe("namespace_unavailable")
    expect(reenabledQuote.reason).not.toBe("Community name claims are currently disabled")
  })

  test("fresh community gets premium short names as default handle policy", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-handle-default-policy-creator")
    const namespaceVerification = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    // Create community without explicit handle_policy — should inherit defaults
    const created = await requestJson("http://pirate.test/communities", {
      display_name: "Default Policy Club",
      membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerification,
      },
    }, ctx.env, creator.accessToken)
    expect(created.status).toBe(202)
    const body = await json(created) as { community: { id: string } }
    const communityId = rawCommunityId(body.community.id)

    const policyResponse = await app.request(
      `http://pirate.test/communities/${communityId}/handle-policy`,
      {
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(policyResponse.status).toBe(200)
    const policy = await json(policyResponse) as {
      policy_template: string
      pricing_model: string
      membership_required_for_claim: boolean
      claims_enabled: boolean
      settings: {
        flat_price_cents: number
        premium_price_cents: number
        premium_max_length: number
        min_length: number
        max_length: number
        special_price_cents_by_label: Record<string, number>
      }
    }
    expect(policy.policy_template).toBe("premium")
    expect(policy.pricing_model).toBe("flat_by_length")
    expect(policy.membership_required_for_claim).toBe(true)
    expect(policy.claims_enabled).toBe(true)
    expect(policy.settings.flat_price_cents).toBe(500)
    expect(policy.settings.premium_price_cents).toBe(2500)
    expect(policy.settings.premium_max_length).toBe(4)
    expect(policy.settings.min_length).toBe(3)
    expect(policy.settings.max_length).toBe(32)
    expect(policy.settings.special_price_cents_by_label.crown).toBe(100000)
    expect(policy.settings.special_price_cents_by_label["xn--2p8h"]).toBe(100000)
    expect(policy.settings.special_price_cents_by_label.prince).toBe(50000)
  })

  test("default premium pricing charges correctly for short and long names", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-handle-default-pricing-creator")
    const namespaceVerification = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    // Create community without explicit handle_policy — defaults to premium short
    const created = await requestJson("http://pirate.test/communities", {
      display_name: "Default Pricing Club",
      membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerification,
      },
    }, ctx.env, creator.accessToken)
    expect(created.status).toBe(202)
    const body = await json(created) as { community: { id: string } }
    const communityId = rawCommunityId(body.community.id)

    // 4-char label is premium ($25)
    const premiumQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "alex" },
      ctx.env,
      creator.accessToken,
    )
    expect(premiumQuoteResponse.status).toBe(200)
    const premiumQuote = await json(premiumQuoteResponse) as {
      price_cents: number
      pricing_tier: string
    }
    expect(premiumQuote.price_cents).toBe(2500)
    expect(premiumQuote.pricing_tier).toBe("premium")

    const crownQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "crown" },
      ctx.env,
      creator.accessToken,
    )
    expect(crownQuoteResponse.status).toBe(200)
    const crownQuote = await json(crownQuoteResponse) as {
      price_cents: number
      pricing_tier: string
    }
    expect(crownQuote.price_cents).toBe(100000)
    expect(crownQuote.pricing_tier).toBe("special")

    // 5-char label is standard ($5)
    const standardQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "alice" },
      ctx.env,
      creator.accessToken,
    )
    expect(standardQuoteResponse.status).toBe(200)
    const standardQuote = await json(standardQuoteResponse) as {
      price_cents: number
      pricing_tier: string
    }
    expect(standardQuote.price_cents).toBe(500)
    expect(standardQuote.pricing_tier).toBe("standard")
  })

  test("patron claims price non-members with multiplier and claim uses quoted price", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-handle-patron-creator")
    const patron = await exchangeJwtWithWallet(ctx.env, "community-handle-patron-buyer")
    const namespaceVerification = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const created = await requestJson("http://pirate.test/communities", {
      display_name: "Patron Pricing Club",
      membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerification,
      },
    }, ctx.env, creator.accessToken)
    expect(created.status).toBe(202)
    const body = await json(created) as { community: { id: string } }
    const communityId = rawCommunityId(body.community.id)

    const enablePatronResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handle-policy`,
      {
        membership_required_for_claim: false,
        settings: {
          flat_price_cents: 500,
          premium_price_cents: 2500,
          premium_max_length: 4,
          min_length: 3,
          max_length: 32,
          non_member_claims_enabled: true,
          non_member_price_multiplier: 5,
          special_price_cents_by_label: {
            crown: 100000,
          },
        },
      },
      ctx.env,
      creator.accessToken,
    )
    expect(enablePatronResponse.status).toBe(200)

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "alice" },
      ctx.env,
      patron.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quote = await json(quoteResponse) as {
      id: string
      price_cents: number
      pricing_tier: string
    }
    expect(quote.price_cents).toBe(2500)
    expect(quote.pricing_tier).toBe("patron_standard")

    const crownQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "crown" },
      ctx.env,
      patron.accessToken,
    )
    expect(crownQuoteResponse.status).toBe(200)
    const crownQuote = await json(crownQuoteResponse) as {
      price_cents: number
      pricing_tier: string
    }
    expect(crownQuote.price_cents).toBe(500000)
    expect(crownQuote.pricing_tier).toBe("patron_special")

    const lowerMultiplierResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handle-policy`,
      {
        membership_required_for_claim: false,
        settings: {
          flat_price_cents: 500,
          premium_price_cents: 2500,
          premium_max_length: 4,
          min_length: 3,
          max_length: 32,
          non_member_claims_enabled: true,
          non_member_price_multiplier: 2,
        },
      },
      ctx.env,
      creator.accessToken,
    )
    expect(lowerMultiplierResponse.status).toBe(200)

    setCommunityCommerceBuyerFundingVerifierForTests(async (input) => ({
      txRef: input.fundingTxRef,
      fromAddress: input.buyerAddress,
      toAddress: input.quote.funding_destination_address ?? "0x5000000000000000000000000000000000000005",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: String(BigInt(Math.round(input.quote.final_price_usd * 1_000_000))),
      chainRef: "eip155:84532",
    }))
    const claimResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      {
        quote: quote.id,
        settlement_wallet_attachment: patron.primaryWalletAttachment,
        funding_tx_ref: "0xpatronfunded",
      },
      ctx.env,
      patron.accessToken,
    )
    expect(claimResponse.status).toBe(200)
    const claim = await json(claimResponse) as {
      label: string
      price_cents: number
      pricing_tier: string
    }
    expect(claim.label).toBe("alice")
    expect(claim.price_cents).toBe(2500)
    expect(claim.pricing_tier).toBe("patron_standard")
  })
})
