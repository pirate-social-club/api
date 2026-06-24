import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import { buildTestEnv, json, mintUpstreamJwt, resetRuntimeCaches } from "../helpers"
import type { Env } from "../../src/types"

const WALLET_A = "0x1111111111111111111111111111111111111111"
const WALLET_B = "0x2222222222222222222222222222222222222222"
const WALLET_C = "0x3333333333333333333333333333333333333333"
const WALLET_D = "0x4444444444444444444444444444444444444444"

type WalletAttachment = { wallet_attachment: string; wallet_address: string; is_primary: boolean }

function request(url: string, init: { method: string; body?: unknown; token?: string }, env: Env): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method: init.method,
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
    env,
  ))
}

async function exchangeWithWallets(
  env: Env,
  sub: string,
  wallets: [string, string] = [WALLET_A, WALLET_B],
): Promise<{
  accessToken: string
  walletAttachments: WalletAttachment[]
}> {
  const jwt = await mintUpstreamJwt(env, {
    sub,
    wallet_addresses: wallets,
    selected_wallet_address: wallets[0],
  })
  const response = await request("http://pirate.test/auth/session/exchange", {
    method: "POST",
    body: { proof: { type: "jwt_based_auth", jwt } },
  }, env)
  const body = await json(response) as { access_token: string; wallet_attachments: WalletAttachment[] }
  return { accessToken: body.access_token, walletAttachments: body.wallet_attachments }
}

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(() => {
  resetRuntimeCaches()
})

describe("PUT /users/me/identity-wallet", () => {
  test("sets the identity wallet to a chosen owned attachment", async () => {
    const env = buildTestEnv()
    const { accessToken, walletAttachments } = await exchangeWithWallets(env, "identity-wallet-success")
    const target = walletAttachments.find((attachment) => attachment.wallet_address === WALLET_B)
    expect(target).toBeDefined()

    const response = await request("http://pirate.test/users/me/identity-wallet", {
      method: "PUT",
      body: { wallet_attachment_id: target!.wallet_attachment },
      token: accessToken,
    }, env)

    expect(response.status).toBe(200)
    const body = await json(response) as { primary_wallet_attachment: string }
    expect(body.primary_wallet_attachment).toBe(target!.wallet_attachment)
  })

  test("rejects a missing or malformed wallet_attachment_id with 400", async () => {
    const env = buildTestEnv()
    const { accessToken } = await exchangeWithWallets(env, "identity-wallet-malformed")

    const missing = await request("http://pirate.test/users/me/identity-wallet", {
      method: "PUT",
      body: {},
      token: accessToken,
    }, env)
    expect(missing.status).toBe(400)

    const wrongType = await request("http://pirate.test/users/me/identity-wallet", {
      method: "PUT",
      body: { wallet_attachment_id: 123 },
      token: accessToken,
    }, env)
    expect(wrongType.status).toBe(400)
  })

  test("returns 404 for a nonexistent or foreign wallet attachment", async () => {
    const env = buildTestEnv()
    const { accessToken } = await exchangeWithWallets(env, "identity-wallet-owner")
    const foreign = await exchangeWithWallets(
      env,
      "identity-wallet-foreigner",
      [WALLET_C, WALLET_D],
    )
    const foreignWalletId = foreign.walletAttachments[0]!.wallet_attachment

    const nonexistent = await request("http://pirate.test/users/me/identity-wallet", {
      method: "PUT",
      body: { wallet_attachment_id: "wal_does_not_exist" },
      token: accessToken,
    }, env)
    expect(nonexistent.status).toBe(404)

    // The owner cannot point their identity wallet at another user's attachment.
    const foreignAttempt = await request("http://pirate.test/users/me/identity-wallet", {
      method: "PUT",
      body: { wallet_attachment_id: foreignWalletId },
      token: accessToken,
    }, env)
    expect(foreignAttempt.status).toBe(404)
  })

  test("requires authentication", async () => {
    const env = buildTestEnv()
    const response = await request("http://pirate.test/users/me/identity-wallet", {
      method: "PUT",
      body: { wallet_attachment_id: "wal_anything" },
    }, env)
    expect(response.status).toBe(401)
  })
})
