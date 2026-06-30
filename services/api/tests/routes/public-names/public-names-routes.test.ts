import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { setCommunityCommerceBuyerFundingVerifierForTests } from "../../../src/lib/communities/commerce/funding-proof-service"
import {
  resolvePirateCheckoutOperatorAddress,
  resolvePirateCheckoutUsdcTokenAddress,
} from "../../../src/lib/communities/commerce/checkout-config"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { exchangeJwt } from "../profiles/profiles-test-helpers"

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

function requestJson(url: string, body: unknown, env: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(app.request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  }, env as never))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForNextOneSecondRateLimitWindow(bufferMs = 75): Promise<void> {
  await sleep(1_000 - (Date.now() % 1_000) + bufferMs)
}

function setSuccessfulPublicNameFundingVerifier(input: {
  env: Parameters<typeof resolvePirateCheckoutOperatorAddress>[0]
  calls?: Array<{
    quoteId: string
    buyerAddress: string
    amountUsd: number
    fundingTxRef: string
  }>
}): void {
  setCommunityCommerceBuyerFundingVerifierForTests(async (fundingInput) => {
    input.calls?.push({
      quoteId: fundingInput.quote.quote_id,
      buyerAddress: fundingInput.buyerAddress,
      amountUsd: fundingInput.quote.final_price_usd,
      fundingTxRef: fundingInput.fundingTxRef,
    })
    return {
      txRef: fundingInput.fundingTxRef,
      fromAddress: fundingInput.buyerAddress,
      toAddress: fundingInput.quote.funding_destination_address ?? resolvePirateCheckoutOperatorAddress(input.env),
      tokenAddress: resolvePirateCheckoutUsdcTokenAddress(input.env),
      amountAtomic: String(BigInt(Math.round(fundingInput.quote.final_price_usd * 1_000_000))),
      chainRef: "eip155:84532",
    }
  })
}

async function createPublicNameQuote(input: {
  env: unknown
  desiredLabel: string
  buyerWalletAddress?: string
}): Promise<{
  quote: string
  price_cents: number
  buyer: { wallet_address: string; chain_ref: string }
  payment_instructions: { amount_atomic: string }
}> {
  const response = await requestJson("http://pirate.test/public-names/quotes", {
    desired_label: input.desiredLabel,
    buyer_wallet_address: input.buyerWalletAddress ?? "0x4000000000000000000000000000000000000004",
  }, input.env)
  expect(response.status).toBe(200)
  return await json(response) as {
    quote: string
    price_cents: number
    buyer: { wallet_address: string; chain_ref: string }
    payment_instructions: { amount_atomic: string }
  }
}

describe("public names routes", () => {
  test("quotes and claims a .pirate name without a Pirate account", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const buyerWallet = "0x2000000000000000000000000000000000000002"
    const fundingCalls: Array<{
      quoteId: string
      buyerAddress: string
      amountUsd: number
      fundingTxRef: string
    }> = []
    setSuccessfulPublicNameFundingVerifier({ env: ctx.env, calls: fundingCalls })

    const quoteResponse = await requestJson("http://pirate.test/public-names/quotes", {
      desired_label: "agent-public-name",
      buyer_wallet_address: buyerWallet,
    }, ctx.env)
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as {
      quote: string
      desired_label: string
      label_normalized: string
      buyer: { wallet_address: string; chain_ref: string }
      price_cents: number
      payment_instructions: {
        token_address: string
        recipient_address: string
        amount_atomic: string
        chain: { chain_id: number; display_name: string }
      }
    }
    expect(quoteBody.quote).toMatch(/^pnq_/)
    expect(quoteBody.desired_label).toBe("agent-public-name.pirate")
    expect(quoteBody.label_normalized).toBe("agent-public-name")
    expect(quoteBody.buyer.wallet_address).toBe(buyerWallet.toLowerCase())
    expect(quoteBody.buyer.chain_ref).toBe("eip155:84532")
    expect(quoteBody.price_cents).toBe(500)
    expect(quoteBody.payment_instructions.chain.chain_id).toBe(84532)
    expect(quoteBody.payment_instructions.chain.display_name).toBe("Base Sepolia")
    expect(quoteBody.payment_instructions.token_address).toBe(resolvePirateCheckoutUsdcTokenAddress(ctx.env))
    expect(quoteBody.payment_instructions.recipient_address).toBe(resolvePirateCheckoutOperatorAddress(ctx.env))
    expect(quoteBody.payment_instructions.amount_atomic).toBe("5000000")

    const claimResponse = await requestJson("http://pirate.test/public-names/claims", {
      quote: quoteBody.quote,
      funding_tx_ref: "0xpublicpiratenamefunding",
    }, ctx.env, {
      authorization: "Payment test-x402-credential",
    })
    expect(claimResponse.status).toBe(200)
    const claimBody = await json(claimResponse) as {
      registration: {
        label: string
        label_normalized: string
        status: string
        owner_kind: string
        owner_wallet_address: string
        chain_ref: string
        price_paid_cents: number
      }
      quote: string
      funding_tx_ref: string
      settlement_tx_ref: string
    }
    expect(claimBody.registration.label).toBe("agent-public-name.pirate")
    expect(claimBody.registration.label_normalized).toBe("agent-public-name")
    expect(claimBody.registration.status).toBe("active")
    expect(claimBody.registration.owner_kind).toBe("wallet")
    expect(claimBody.registration.owner_wallet_address).toBe(buyerWallet.toLowerCase())
    expect(claimBody.registration.chain_ref).toBe("eip155:84532")
    expect(claimBody.registration.price_paid_cents).toBe(500)
    expect(claimBody.quote).toBe(quoteBody.quote)
    expect(claimBody.funding_tx_ref).toBe("0xpublicpiratenamefunding")
    expect(claimBody.settlement_tx_ref).toBe("0xpublicpiratenamefunding")
    expect(fundingCalls).toEqual([{
      quoteId: quoteBody.quote,
      buyerAddress: buyerWallet.toLowerCase(),
      amountUsd: 5,
      fundingTxRef: "0xpublicpiratenamefunding",
    }])

    const statusResponse = await app.request("http://pirate.test/public-names/agent-public-name/status", {}, ctx.env)
    expect(statusResponse.status).toBe(200)
    const statusBody = await json(statusResponse) as {
      status: string
      registration: { label: string; owner_wallet_address: string }
    }
    expect(statusBody.status).toBe("registered")
    expect(statusBody.registration.label).toBe("agent-public-name.pirate")
    expect(statusBody.registration.owner_wallet_address).toBe(buyerWallet.toLowerCase())
  })

  test("claim replay returns the already registered wallet-owned name", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const fundingCalls: Array<{
      quoteId: string
      buyerAddress: string
      amountUsd: number
      fundingTxRef: string
    }> = []
    setSuccessfulPublicNameFundingVerifier({ env: ctx.env, calls: fundingCalls })
    const quote = await createPublicNameQuote({
      env: ctx.env,
      desiredLabel: "replay-public-name",
    })

    const firstClaim = await requestJson("http://pirate.test/public-names/claims", {
      quote: quote.quote,
      funding_tx_ref: "0xpublicnamereplay",
    }, ctx.env)
    expect(firstClaim.status).toBe(200)
    const firstBody = await json(firstClaim) as {
      registration: { id: string; label: string }
      funding_tx_ref: string
    }

    const replayClaim = await requestJson("http://pirate.test/public-names/claims", {
      quote: quote.quote,
      funding_tx_ref: "0xpublicnamereplay",
    }, ctx.env)
    expect(replayClaim.status).toBe(200)
    const replayBody = await json(replayClaim) as {
      registration: { id: string; label: string }
      funding_tx_ref: string
    }
    expect(replayBody.registration.id).toBe(firstBody.registration.id)
    expect(replayBody.registration.label).toBe("replay-public-name.pirate")
    expect(replayBody.funding_tx_ref).toBe("0xpublicnamereplay")
    expect(fundingCalls).toHaveLength(1)
  })

  test("expired public name quote is rejected and marked expired", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const quote = await createPublicNameQuote({
      env: ctx.env,
      desiredLabel: "expired-public-name",
    })
    await ctx.client.execute({
      sql: `
        UPDATE pirate_name_quotes
        SET expires_at = ?2,
            updated_at = ?2
        WHERE pirate_name_quote_id = ?1
      `,
      args: [quote.quote, new Date(Date.now() - 60_000).toISOString()],
    })

    const claimResponse = await requestJson("http://pirate.test/public-names/claims", {
      quote: quote.quote,
      funding_tx_ref: "0xexpiredpublicname",
    }, ctx.env)
    expect(claimResponse.status).toBe(403)
    const claimBody = await json(claimResponse) as { code: string; message: string }
    expect(claimBody.code).toBe("eligibility_failed")
    expect(claimBody.message).toBe("Public pirate name quote has expired")
    const quoteRow = (await ctx.client.execute({
      sql: "SELECT status FROM pirate_name_quotes WHERE pirate_name_quote_id = ?1 LIMIT 1",
      args: [quote.quote],
    })).rows[0]
    expect(quoteRow?.status).toBe("expired")
  })

  test("policy drift rejects claim and marks public name quote failed", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    setSuccessfulPublicNameFundingVerifier({ env: ctx.env })
    const quote = await createPublicNameQuote({
      env: ctx.env,
      desiredLabel: "drift-public-name",
    })
    await ctx.client.execute({
      sql: `
        UPDATE pirate_name_quotes
        SET price_cents = price_cents + 100,
            updated_at = ?2
        WHERE pirate_name_quote_id = ?1
      `,
      args: [quote.quote, new Date().toISOString()],
    })

    const claimResponse = await requestJson("http://pirate.test/public-names/claims", {
      quote: quote.quote,
      funding_tx_ref: "0xdriftpublicname",
    }, ctx.env)
    expect(claimResponse.status).toBe(403)
    const claimBody = await json(claimResponse) as { code: string; message: string }
    expect(claimBody.code).toBe("eligibility_failed")
    expect(claimBody.message).toBe("Public pirate name quote is no longer claimable under the current pricing policy")
    const quoteRow = (await ctx.client.execute({
      sql: "SELECT status FROM pirate_name_quotes WHERE pirate_name_quote_id = ?1 LIMIT 1",
      args: [quote.quote],
    })).rows[0]
    expect(quoteRow?.status).toBe("failed")
  })

  test("claim fails if an authenticated global handle takes the label after quote", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    setSuccessfulPublicNameFundingVerifier({ env: ctx.env })
    const quote = await createPublicNameQuote({
      env: ctx.env,
      desiredLabel: "race-public-name",
    })
    const user = await exchangeJwt(ctx.env, "public-name-race-global-handle-owner")
    await ctx.client.execute({
      sql: `
        UPDATE global_handles
        SET label_normalized = 'race-public-name',
            label_display = 'race-public-name.pirate',
            updated_at = ?2
        WHERE user_id = ?1
          AND status = 'active'
      `,
      args: [user.userId, new Date().toISOString()],
    })

    const claimResponse = await requestJson("http://pirate.test/public-names/claims", {
      quote: quote.quote,
      funding_tx_ref: "0xracepublicname",
    }, ctx.env)
    expect(claimResponse.status).toBe(409)
    const claimBody = await json(claimResponse) as { code: string; message: string }
    expect(claimBody.code).toBe("conflict")
    expect(claimBody.message).toBe("Desired label is unavailable")
  })

  test("second wallet cannot quote a label while another wallet has an active quote", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    await createPublicNameQuote({
      env: ctx.env,
      desiredLabel: "reserved-public-name",
      buyerWalletAddress: "0x5000000000000000000000000000000000000005",
    })

    const quoteResponse = await requestJson("http://pirate.test/public-names/quotes", {
      desired_label: "reserved-public-name",
      buyer_wallet_address: "0x6000000000000000000000000000000000000006",
    }, ctx.env)
    expect(quoteResponse.status).toBe(403)
    const quoteBody = await json(quoteResponse) as { code: string; message: string }
    expect(quoteBody.code).toBe("eligibility_failed")
    expect(quoteBody.message).toBe("Desired label is unavailable")
  })

  test("rejects public quotes for labels already active in global handles", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const user = await exchangeJwt(ctx.env, "public-name-global-handle-owner")
    await ctx.client.execute({
      sql: `
        UPDATE global_handles
        SET label_normalized = 'taken-public-name',
            label_display = 'taken-public-name.pirate',
            updated_at = ?2
        WHERE user_id = ?1
          AND status = 'active'
      `,
      args: [user.userId, new Date().toISOString()],
    })

    const quoteResponse = await requestJson("http://pirate.test/public-names/quotes", {
      desired_label: "taken-public-name",
      buyer_wallet_address: "0x3000000000000000000000000000000000000003",
    }, ctx.env)
    expect(quoteResponse.status).toBe(403)
    const quoteBody = await json(quoteResponse) as { code: string; message: string }
    expect(quoteBody.code).toBe("eligibility_failed")
    expect(quoteBody.message).toBe("Desired label is unavailable")

    const statusResponse = await app.request("http://pirate.test/public-names/taken-public-name/status", {}, ctx.env)
    expect(statusResponse.status).toBe(200)
    const statusBody = await json(statusResponse) as { status: string; owner_kind: string }
    expect(statusBody.status).toBe("taken")
    expect(statusBody.owner_kind).toBe("user")
  })

  test("rejects public quotes for labels exceeding max length", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const longLabel = "a".repeat(33)
    const quoteResponse = await requestJson("http://pirate.test/public-names/quotes", {
      desired_label: longLabel,
      buyer_wallet_address: "0x3000000000000000000000000000000000000003",
    }, ctx.env)
    expect(quoteResponse.status).toBe(400)
    const quoteBody = await json(quoteResponse) as { code: string; message: string }
    expect(quoteBody.code).toBe("bad_request")
    expect(quoteBody.message).toBe("desired_label must be at most 32 characters")

    const rows = await ctx.client.execute({
      sql: "SELECT COUNT(*) as count FROM public_name_quote_rate_limits",
    })
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(0)
  })

  test("rate limits public quotes by wallet address", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const buyerWallet = "0x7000000000000000000000000000000000000007"
    const limit = 5

    for (let i = 0; i < limit; i++) {
      const res = await requestJson("http://pirate.test/public-names/quotes", {
        desired_label: `rate-limit-wallet-${i}`,
        buyer_wallet_address: buyerWallet,
      }, ctx.env)
      expect(res.status).toBe(200)
    }

    const blocked = await requestJson("http://pirate.test/public-names/quotes", {
      desired_label: "rate-limit-wallet-blocked",
      buyer_wallet_address: buyerWallet,
    }, ctx.env)
    expect(blocked.status).toBe(429)
    const blockedBody = await json(blocked) as { code: string; message: string; retryable: boolean }
    expect(blockedBody.code).toBe("rate_limited")
    expect(blockedBody.retryable).toBe(true)
  })

  test("rate limits public quotes by IP address", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const ipLimit = 10
    for (let i = 0; i < ipLimit; i++) {
      const res = await requestJson("http://pirate.test/public-names/quotes", {
        desired_label: `rate-limit-ip-${i}`,
        buyer_wallet_address: `0x${String(i + 100).padStart(40, "0")}`,
      }, ctx.env, {
        "x-forwarded-for": "10.0.0.1",
      })
      expect(res.status).toBe(200)
    }

    const blocked = await requestJson("http://pirate.test/public-names/quotes", {
      desired_label: "rate-limit-ip-blocked",
      buyer_wallet_address: "0x0000000000000000000000000000000000000101",
    }, ctx.env, {
      "x-forwarded-for": "10.0.0.1",
    })
    expect(blocked.status).toBe(429)
    const blockedBody = await json(blocked) as { code: string; retryable: boolean }
    expect(blockedBody.code).toBe("rate_limited")
    expect(blockedBody.retryable).toBe(true)

    // Same wallet from a different IP should still succeed
    const differentIp = await requestJson("http://pirate.test/public-names/quotes", {
      desired_label: "rate-limit-ip-different-ip",
      buyer_wallet_address: "0x0000000000000000000000000000000000000101",
    }, ctx.env, {
      "x-forwarded-for": "10.0.0.2",
    })
    expect(differentIp.status).toBe(200)
  })

  test("rate limit window resets after window expires", async () => {
    const ctx = await createRouteTestContext({
      PUBLIC_NAME_QUOTE_RATE_LIMIT_WINDOW_SECONDS: "1",
    })
    cleanup = ctx.cleanup

    await waitForNextOneSecondRateLimitWindow()

    const buyerWallet = "0x8000000000000000000000000000000000000008"
    const limit = 5
    for (let i = 0; i < limit; i++) {
      const res = await requestJson("http://pirate.test/public-names/quotes", {
        desired_label: `rate-limit-window-${i}`,
        buyer_wallet_address: buyerWallet,
      }, ctx.env)
      expect(res.status).toBe(200)
    }

    const blocked = await requestJson("http://pirate.test/public-names/quotes", {
      desired_label: "rate-limit-window-blocked",
      buyer_wallet_address: buyerWallet,
    }, ctx.env)
    expect(blocked.status).toBe(429)

    await waitForNextOneSecondRateLimitWindow()

    const afterWindow = await requestJson("http://pirate.test/public-names/quotes", {
      desired_label: "rate-limit-window-after",
      buyer_wallet_address: buyerWallet,
    }, ctx.env)
    expect(afterWindow.status).toBe(200)
  })

  test("invalid wallet returns 400 and does not write rate limit rows", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const res = await requestJson("http://pirate.test/public-names/quotes", {
      desired_label: "bad-wallet",
      buyer_wallet_address: "not-an-evm-address",
    }, ctx.env)
    expect(res.status).toBe(400)
    const body = await json(res) as { code: string; message: string }
    expect(body.code).toBe("bad_request")
    expect(body.message).toBe("buyer_wallet_address must be a valid EVM address")

    const rows = await ctx.client.execute({
      sql: "SELECT COUNT(*) as count FROM public_name_quote_rate_limits",
    })
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(0)
  })
})
