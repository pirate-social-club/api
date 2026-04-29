import { afterEach, describe, expect, test } from "bun:test"
import app from "../../src/index"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "../helpers"
import type { Env } from "../../src/types"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  resetRuntimeCaches()
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function adminPost(env: Env, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(`http://pirate.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-token": "test-admin-token",
    },
    body: JSON.stringify(body),
  }, env))
}

function postJson(env: Env, path: string, body: unknown, token?: string): Promise<Response> {
  return Promise.resolve(app.request(`http://pirate.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }, env))
}

async function exchangeJwt(env: Env, sub: string, walletAddress?: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, {
    sub,
    ...(walletAddress ? { wallet_address: walletAddress } : {}),
  })
  const response = await postJson(env, "/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  })
  const body = await json(response) as { access_token: string; user: { user_id: string } }
  return {
    accessToken: body.access_token,
    userId: body.user.user_id,
  }
}

describe("bot user admin routes", () => {
  test("provisions a bot user idempotently with a primary external wallet", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: "test-admin-token" })
    cleanup = ctx.cleanup

    const provisioned = await adminPost(ctx.env, "/admin/bot-users/provision", {
      handle: "habibi.pirate",
      display_name: "Habibi",
      bio: "Stable bot personality",
      wallet_address: "0xa6e5bf94ecae349850cc5603dfbb920417fc4eb1",
    })
    expect(provisioned.status).toBe(201)
    const provisionedBody = await json(provisioned) as {
      created: boolean
      user_id: string
      profile: { display_name: string | null; primary_wallet_address: string | null; global_handle: { label: string } }
      wallet_attachments: Array<{ wallet_address: string; is_primary: boolean }>
    }
    expect(provisionedBody.created).toBe(true)
    expect(provisionedBody.profile.display_name).toBe("Habibi")
    expect(provisionedBody.profile.global_handle.label).toBe("habibi.pirate")
    expect(provisionedBody.profile.primary_wallet_address).toBe("0xa6e5bf94ecae349850cc5603dfbb920417fc4eb1")
    expect(provisionedBody.wallet_attachments.length).toBe(1)
    expect(provisionedBody.wallet_attachments[0].is_primary).toBe(true)

    const updated = await adminPost(ctx.env, "/admin/bot-users/provision", {
      handle: "HABIBI.PIRATE",
      display_name: "Habibi Bot",
      wallet_address: "0xa6e5bf94ecae349850cc5603dfbb920417fc4eb1",
    })
    expect(updated.status).toBe(200)
    const updatedBody = await json(updated) as {
      created: boolean
      user_id: string
      profile: { display_name: string | null }
      wallet_attachments: Array<{ wallet_address: string }>
    }
    expect(updatedBody.created).toBe(false)
    expect(updatedBody.user_id).toBe(provisionedBody.user_id)
    expect(updatedBody.profile.display_name).toBe("Habibi Bot")
    expect(updatedBody.wallet_attachments.length).toBe(1)

    const linkRows = await ctx.client.execute({
      sql: `
        SELECT provider, provider_subject
        FROM auth_provider_links
        WHERE user_id = ?1
      `,
      args: [provisionedBody.user_id],
    })
    expect(linkRows.rows.length).toBe(1)
    expect(String((linkRows.rows[0] as { provider?: unknown }).provider)).toBe("bot")
    expect(String((linkRows.rows[0] as { provider_subject?: unknown }).provider_subject)).toBe("bot:habibi.pirate")
  })

  test("mints a normal Pirate access token only for bot users", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: "test-admin-token" })
    cleanup = ctx.cleanup

    const provisioned = await adminPost(ctx.env, "/admin/bot-users/provision", {
      handle: "swift-comet-1431.pirate",
      wallet_address: "0xb6e5bf94ecae349850cc5603dfbb920417fc4eb2",
    })
    const provisionedBody = await json(provisioned) as { user_id: string }

    const minted = await adminPost(ctx.env, `/admin/bot-users/${provisionedBody.user_id}/token`, {})
    expect(minted.status).toBe(200)
    const mintedBody = await json(minted) as { access_token: string; user_id: string; token_type: string }
    expect(mintedBody.user_id).toBe(provisionedBody.user_id)
    expect(mintedBody.token_type).toBe("Bearer")

    const me = await app.request("http://pirate.test/users/me", {
      headers: {
        authorization: `Bearer ${mintedBody.access_token}`,
      },
    }, ctx.env)
    expect(me.status).toBe(200)

    const mintedByHandle = await adminPost(ctx.env, "/admin/bot-users/handle/swift-comet-1431.pirate/token", {})
    expect(mintedByHandle.status).toBe(200)
    const mintedByHandleBody = await json(mintedByHandle) as { user_id: string }
    expect(mintedByHandleBody.user_id).toBe(provisionedBody.user_id)
  })

  test("rejects missing admin token, invalid wallet addresses, non-bot handles, and human wallet collisions", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: "test-admin-token" })
    cleanup = ctx.cleanup

    const missingAdmin = await postJson(ctx.env, "/admin/bot-users/provision", {
      handle: "missing-admin.pirate",
      wallet_address: "0xc6e5bf94ecae349850cc5603dfbb920417fc4eb3",
    })
    expect(missingAdmin.status).toBe(401)

    const invalidWallet = await adminPost(ctx.env, "/admin/bot-users/provision", {
      handle: "bad-wallet.pirate",
      wallet_address: "not-a-wallet",
    })
    expect(invalidWallet.status).toBe(400)

    const human = await exchangeJwt(ctx.env, "human-owner")
    const renamed = await postJson(ctx.env, "/profiles/me/global-handle/rename", {
      desired_label: "humanowned",
    }, human.accessToken)
    expect(renamed.status).toBe(200)

    const nonBotHandle = await adminPost(ctx.env, "/admin/bot-users/provision", {
      handle: "humanowned.pirate",
      wallet_address: "0xd6e5bf94ecae349850cc5603dfbb920417fc4eb4",
    })
    expect(nonBotHandle.status).toBe(409)

    const humanWithWallet = await exchangeJwt(ctx.env, "human-wallet-owner", "0xe6e5bf94ecae349850cc5603dfbb920417fc4eb5")
    expect(humanWithWallet.userId.length > 0).toBe(true)
    const walletCollision = await adminPost(ctx.env, "/admin/bot-users/provision", {
      handle: "wallet-collision.pirate",
      wallet_address: "0xe6e5bf94ecae349850cc5603dfbb920417fc4eb5",
    })
    expect(walletCollision.status).toBe(409)
  })

  test("does not mint bot tokens for non-bot users", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: "test-admin-token" })
    cleanup = ctx.cleanup

    const human = await exchangeJwt(ctx.env, "not-a-bot")
    const minted = await adminPost(ctx.env, `/admin/bot-users/${human.userId}/token`, {})
    expect(minted.status).toBe(404)
  })
})
