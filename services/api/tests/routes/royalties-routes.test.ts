import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../src/index"
import { reconcileRoyaltyClaimEvents } from "../../src/lib/royalties/royalty-claim-history"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { exchangeJwt } from "./communities/community-routes-test-helpers"

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

function authHeaders(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` }
}

describe("royalties routes", () => {
  test("records and lists on-chain royalty claim transactions", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "royalty-claim-user")
    const otherSession = await exchangeJwt(ctx.env, "royalty-claim-other-user")

    const payload = {
      tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wallet_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      chain_id: 1514,
      claimable_wip_wei_at_submission: "12450000000000000000",
      ip_ids: [
        "0x1111111111111111111111111111111111111111",
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ],
      auto_unwrap_ip_tokens: true,
    }

    const created = await app.request(
      "http://pirate.test/royalties/claims",
      {
        method: "POST",
        headers: {
          ...authHeaders(session.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      ctx.env,
    )
    expect(created.status).toBe(201)
    const createdBody = await json(created) as {
      claim_id: string
      tx_hash: string
      wallet_address: string
      ip_ids: string[]
      claimable_wip_wei_at_submission: string
      auto_unwrap_ip_tokens: boolean
      status: string
      verified_at: string | null
      verification_error: string | null
    }
    expect(createdBody.tx_hash).toBe(payload.tx_hash)
    expect(createdBody.wallet_address).toBe(payload.wallet_address)
    expect(createdBody.ip_ids).toEqual([
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ])
    expect(createdBody.claimable_wip_wei_at_submission).toBe("12450000000000000000")
    expect(createdBody.auto_unwrap_ip_tokens).toBe(true)
    expect(createdBody.status).toBe("pending")
    expect(createdBody.verified_at).toBeNull()
    expect(createdBody.verification_error).toBeNull()

    const duplicate = await app.request(
      "http://pirate.test/royalties/claims",
      {
        method: "POST",
        headers: {
          ...authHeaders(session.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      ctx.env,
    )
    expect(duplicate.status).toBe(201)
    const duplicateBody = await json(duplicate) as { claim_id: string }
    expect(duplicateBody.claim_id).toBe(createdBody.claim_id)

    const claims = await app.request(
      "http://pirate.test/royalties/claims?limit=10",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(claims.status).toBe(200)
    const claimsBody = await json(claims) as { items: Array<{ tx_hash: string; claim_id: string }> }
    expect(claimsBody.items).toHaveLength(1)
    expect(claimsBody.items[0]?.tx_hash).toBe(payload.tx_hash)
    expect(claimsBody.items[0]?.claim_id).toBe(createdBody.claim_id)

    const otherClaims = await app.request(
      "http://pirate.test/royalties/claims?limit=10",
      { headers: authHeaders(otherSession.accessToken) },
      ctx.env,
    )
    expect(otherClaims.status).toBe(200)
    const otherClaimsBody = await json(otherClaims) as { items: unknown[] }
    expect(otherClaimsBody.items).toHaveLength(0)

    const duplicateForOtherUser = await app.request(
      "http://pirate.test/royalties/claims",
      {
        method: "POST",
        headers: {
          ...authHeaders(otherSession.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      ctx.env,
    )
    expect(duplicateForOtherUser.status).toBe(409)
    const duplicateForOtherUserBody = await json(duplicateForOtherUser) as { code: string }
    expect(duplicateForOtherUserBody.code).toBe("conflict")
  })

  test("reconciles pending claim transactions from chain receipts", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "royalty-claim-reconcile-user")
    const txHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

    const created = await app.request(
      "http://pirate.test/royalties/claims",
      {
        method: "POST",
        headers: {
          ...authHeaders(session.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tx_hash: txHash,
          wallet_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          chain_id: 1514,
          claimable_wip_wei_at_submission: "4000000000000000000",
          ip_ids: ["0x1111111111111111111111111111111111111111"],
          auto_unwrap_ip_tokens: false,
        }),
      },
      ctx.env,
    )
    expect(created.status).toBe(201)

    const summary = await reconcileRoyaltyClaimEvents({
      env: ctx.env,
      getReceiptStatus: async (hash) => hash === txHash ? "success" : "not_found",
    })
    expect(summary).toMatchObject({ checked: 1, confirmed: 1, failed: 0, pending: 0 })

    const claims = await app.request(
      "http://pirate.test/royalties/claims?limit=10",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(claims.status).toBe(200)
    const claimsBody = await json(claims) as {
      items: Array<{ status: string; verified_at: string | null; verification_error: string | null }>
    }
    expect(claimsBody.items[0]?.status).toBe("confirmed")
    expect(typeof claimsBody.items[0]?.verified_at).toBe("string")
    expect(claimsBody.items[0]?.verification_error).toBeNull()
  })

  test("rejects invalid claim transaction hashes", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "royalty-claim-invalid-user")

    const response = await app.request(
      "http://pirate.test/royalties/claims",
      {
        method: "POST",
        headers: {
          ...authHeaders(session.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tx_hash: "0x1234",
          wallet_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          chain_id: 1514,
          claimable_wip_wei_at_submission: "1",
          ip_ids: [],
          auto_unwrap_ip_tokens: true,
        }),
      },
      ctx.env,
    )
    expect(response.status).toBe(400)
    const body = await json(response) as { code: string }
    expect(body.code).toBe("bad_request")
  })
})
