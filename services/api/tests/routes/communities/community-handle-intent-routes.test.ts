import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { app } from "../../../src/index"
import {
  json,
  createRouteTestContext,
  mintUpstreamJwt,
  resetRuntimeCaches,
} from "../../helpers"
import { setCommunityCommerceBuyerFundingVerifierForTests } from "../../../src/lib/communities/commerce/funding-proof-service"
import {
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => resetRuntimeCaches())

afterEach(async () => {
  setCommunityCommerceBuyerFundingVerifierForTests(null)
  if (cleanup) await cleanup()
  cleanup = null
})

describe("community handle claim intents", () => {
  test("binds and consumes a free quote authorization end to end", async () => {
    const context = await createRouteTestContext()
    cleanup = context.cleanup
    context.env.COMMUNITY_HANDLE_CLAIM_INTENTS_ENABLED = "true"

    const account = await exchangeJwt(context.env, "handle-intent-account")
    const namespaceVerification = await prepareVerifiedNamespace(context.env, account.accessToken)
    const createResponse = await requestJson("http://pirate.test/communities", {
      display_name: "Handle Intent Community",
      membership_mode: "request",
      handle_policy: { policy_template: "standard", pricing_model: "free" },
      namespace: { namespace_verification: namespaceVerification },
    }, context.env, account.accessToken)
    expect(createResponse.status).toBe(202)
    const created = await json(createResponse) as { community: { id: string } }
    const communityId = created.community.id.replace(/^com_/, "")

    const enableResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handle-policy`,
      { claims_enabled: true },
      context.env,
      account.accessToken,
    )
    expect(enableResponse.status).toBe(200)

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "cardholder" },
      context.env,
      account.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quote = await json(quoteResponse) as {
      id: string
      claim_intent: string | null
      action_authorization: string | null
      price_cents: number
    }
    expect(quote.price_cents).toBe(0)
    expect(typeof quote.claim_intent).toBe("string")
    expect(typeof quote.action_authorization).toBe("string")
    expect(quote.claim_intent).toMatch(/^hci_/u)
    expect(quote.action_authorization).toMatch(/^hcaa_/u)

    const claimResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      {
        quote: quote.id,
        claim_intent: quote.claim_intent,
        action_authorization: quote.action_authorization,
      },
      context.env,
      account.accessToken,
    )
    expect(claimResponse.status).toBe(200)
    expect(await json(claimResponse)).toMatchObject({
      object: "community_handle",
      label: "cardholder",
      status: "active",
      price_cents: 0,
    })

    const repeatedClaim = await app.request(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${account.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          quote: quote.id,
          claim_intent: quote.claim_intent,
          action_authorization: quote.action_authorization,
        }),
      },
      context.env,
    )
    expect(repeatedClaim.status).toBe(200)
    expect(await json(repeatedClaim)).toMatchObject({ label: "cardholder", status: "active" })
  })

  test("claims and replays paid funding through the stable intent consumer", async () => {
    const context = await createRouteTestContext({
      COMMUNITY_HANDLE_CLAIM_INTENTS_ENABLED: "true",
      COMMUNITY_HANDLE_CLAIM_REFUNDS_ENABLED: "true",
      PIRATE_CHECKOUT_CUSTODY_KEY_EPOCH: "epoch_test",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: `0x${"77".repeat(32)}`,
    })
    cleanup = context.cleanup
    const walletAddress = "0x1000000000000000000000000000000000000001"
    const upstreamJwt = await mintUpstreamJwt(context.env, {
      sub: "paid-handle-intent-account",
      wallet_address: walletAddress,
    })
    const exchangeResponse = await requestJson("http://pirate.test/auth/session/exchange", {
      proof: { type: "jwt_based_auth", jwt: upstreamJwt },
    }, context.env)
    expect(exchangeResponse.status).toBe(200)
    const exchanged = await json(exchangeResponse) as {
      access_token: string
      user: { primary_wallet_attachment: string }
    }
    const namespaceVerification = await prepareVerifiedNamespace(context.env, exchanged.access_token)
    const createResponse = await requestJson("http://pirate.test/communities", {
      display_name: "Paid Handle Intent Community",
      membership_mode: "request",
      handle_policy: { policy_template: "standard", pricing_model: "free" },
      namespace: { namespace_verification: namespaceVerification },
    }, context.env, exchanged.access_token)
    const created = await json(createResponse) as { community: { id: string } }
    const communityId = created.community.id.replace(/^com_/, "")
    const policyResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handle-policy`,
      {
        claims_enabled: true,
        pricing_model: "flat_by_length",
        settings: { flat_price_cents: 500, quote_ttl_seconds: 600 },
      },
      context.env,
      exchanged.access_token,
    )
    expect(policyResponse.status).toBe(200)

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "paidcard" },
      context.env,
      exchanged.access_token,
    )
    expect(quoteResponse.status).toBe(200)
    const quote = await json(quoteResponse) as {
      id: string
      claim_intent: string
      action_authorization: string
      price_cents: number
    }
    expect(quote.price_cents).toBe(500)
    expect(typeof quote.claim_intent).toBe("string")
    expect(typeof quote.action_authorization).toBe("string")

    const fundingTxHash = `0x${"66".repeat(32)}`
    setCommunityCommerceBuyerFundingVerifierForTests(async (input) => ({
      txRef: input.fundingTxRef,
      fromAddress: input.buyerAddress,
      toAddress: input.quote.funding_destination_address!,
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: String(BigInt(input.quote.final_price_cents * 10_000)),
      chainRef: "eip155:84532",
      observation: {
        chainId: 84532,
        logIndex: 17,
        blockNumber: 12_400,
        blockHash: `0x${"55".repeat(32)}`,
        blockTimestamp: Math.floor(Date.now() / 1000),
      },
    }))
    const claimBody = {
      quote: quote.id,
      claim_intent: quote.claim_intent,
      action_authorization: quote.action_authorization,
      settlement_wallet_attachment: exchanged.user.primary_wallet_attachment,
      funding_tx_ref: fundingTxHash,
    }
    const claimResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      claimBody,
      context.env,
      exchanged.access_token,
    )
    expect(claimResponse.status).toBe(200)
    expect(await json(claimResponse)).toMatchObject({
      label: "paidcard",
      funding_tx_ref: fundingTxHash,
      price_cents: 500,
    })

    const registry = await context.client.execute({
      sql: `SELECT consumer_rail, consumer_id, quote_id, match_status
            FROM observed_funding_receipts WHERE tx_hash = ?1 AND log_index = 17`,
      args: [fundingTxHash],
    })
    expect(registry.rows[0]).toMatchObject({
      consumer_rail: "community_handle_intent",
      consumer_id: quote.claim_intent,
      match_status: "claimed",
    })

    const repeatedResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      claimBody,
      context.env,
      exchanged.access_token,
    )
    expect(repeatedResponse.status).toBe(200)
    expect(await json(repeatedResponse)).toMatchObject({ label: "paidcard", funding_tx_ref: fundingTxHash })
  })

  test("adopts a paid quote created before the intent flag is enabled", async () => {
    const context = await createRouteTestContext({
      COMMUNITY_HANDLE_CLAIM_INTENTS_ENABLED: "false",
      COMMUNITY_HANDLE_CLAIM_REFUNDS_ENABLED: "true",
      PIRATE_CHECKOUT_CUSTODY_KEY_EPOCH: "epoch_test",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: `0x${"77".repeat(32)}`,
    })
    cleanup = context.cleanup
    const walletAddress = "0x1000000000000000000000000000000000000002"
    const upstreamJwt = await mintUpstreamJwt(context.env, {
      sub: "paid-handle-cutover-account",
      wallet_address: walletAddress,
    })
    const exchangeResponse = await requestJson("http://pirate.test/auth/session/exchange", {
      proof: { type: "jwt_based_auth", jwt: upstreamJwt },
    }, context.env)
    const exchanged = await json(exchangeResponse) as {
      access_token: string
      user: { primary_wallet_attachment: string }
    }
    const namespaceVerification = await prepareVerifiedNamespace(context.env, exchanged.access_token)
    const createResponse = await requestJson("http://pirate.test/communities", {
      display_name: "Handle Cutover Community",
      membership_mode: "request",
      handle_policy: { policy_template: "standard", pricing_model: "free" },
      namespace: { namespace_verification: namespaceVerification },
    }, context.env, exchanged.access_token)
    const created = await json(createResponse) as { community: { id: string } }
    const communityId = created.community.id.replace(/^com_/, "")
    const policyResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handle-policy`,
      {
        claims_enabled: true,
        pricing_model: "flat_by_length",
        settings: { flat_price_cents: 500, quote_ttl_seconds: 600 },
      },
      context.env,
      exchanged.access_token,
    )
    expect(policyResponse.status).toBe(200)

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/quote`,
      { desired_label: "cutovercard" },
      context.env,
      exchanged.access_token,
    )
    const quote = await json(quoteResponse) as {
      id: string
      claim_intent?: string | null
      price_cents: number
    }
    expect(quote.price_cents).toBe(500)
    expect(quote.claim_intent ?? null).toBeNull()

    context.env.COMMUNITY_HANDLE_CLAIM_INTENTS_ENABLED = "true"
    const fundingTxHash = `0x${"67".repeat(32)}`
    setCommunityCommerceBuyerFundingVerifierForTests(async (input) => ({
      txRef: input.fundingTxRef,
      fromAddress: input.buyerAddress,
      toAddress: input.quote.funding_destination_address!,
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: String(BigInt(input.quote.final_price_cents * 10_000)),
      chainRef: "eip155:84532",
      observation: {
        chainId: 84532,
        logIndex: 18,
        blockNumber: 12_401,
        blockHash: `0x${"56".repeat(32)}`,
        blockTimestamp: Math.floor(Date.now() / 1000),
      },
    }))
    const claimResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/claim`,
      {
        quote: quote.id,
        settlement_wallet_attachment: exchanged.user.primary_wallet_attachment,
        funding_tx_ref: fundingTxHash,
      },
      context.env,
      exchanged.access_token,
    )
    expect(claimResponse.status).toBe(200)
    expect(await json(claimResponse)).toMatchObject({
      label: "cutovercard",
      funding_tx_ref: fundingTxHash,
      price_cents: 500,
    })

    const registry = await context.client.execute({
      sql: `SELECT consumer_rail, consumer_id, match_status
            FROM observed_funding_receipts WHERE tx_hash = ?1 AND log_index = 18`,
      args: [fundingTxHash],
    })
    expect(registry.rows[0]?.consumer_rail).toBe("community_handle_intent")
    expect(String(registry.rows[0]?.consumer_id)).toMatch(/^hci_/u)
    expect(registry.rows[0]?.match_status).toBe("claimed")
  })
})
