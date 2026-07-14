import { afterEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import type { Env } from "../../src/types"
import { createRouteTestContext, json } from "../helpers"

const ADMIN_TOKEN = "test-admin-token-abc123"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function getWallets(env: Env, token?: string): Promise<Response> {
  return Promise.resolve(app.request(
    "http://pirate.test/admin/ops/wallets",
    { headers: token ? { "x-admin-token": token } : {} },
    env,
  ))
}

describe("GET /admin/ops/wallets", () => {
  test("rejects requests without the admin token", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const missing = await getWallets(ctx.env)
    expect(missing.status).toBe(401)

    const wrong = await getWallets(ctx.env, "not-the-token")
    expect(wrong.status).toBe(401)
  })

  test("reports wallet statuses for the admin token", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const response = await getWallets(ctx.env, ADMIN_TOKEN)
    expect(response.status).toBe(200)

    const body = await json(response) as {
      ok: boolean
      wallets: Array<{ wallet: string; error?: string }>
    }
    // The route-test env has no Story signer keys (that section degrades to a
    // single error entry rather than failing the request) and points the Base
    // operator wallets at an unreachable local RPC, so every entry carries an
    // error and the roll-up is not ok.
    expect(body.ok).toBe(false)
    expect(body.wallets.map((wallet) => wallet.wallet)).toEqual([
      "story-runtime-signers",
      "base-checkout-operator",
      "base-booking-operator",
    ])
    expect(body.wallets.every((wallet) => Boolean(wallet.error))).toBe(true)
  })
})
