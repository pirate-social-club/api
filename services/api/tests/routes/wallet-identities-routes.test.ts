import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { exchangeJwtWithWallet } from "./profiles/profiles-test-helpers"

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

async function insertWalletPublicName(input: {
  buyerWallet: string
  chainRef?: string
  ctx: Awaited<ReturnType<typeof createRouteTestContext>>
  id: string
  issuedAt?: string
  label: string
}) {
  const chainRef = input.chainRef ?? "eip155:84532"
  const now = input.issuedAt ?? new Date().toISOString()
  await input.ctx.client.execute({
    sql: `
      INSERT INTO pirate_name_quotes (
        pirate_name_quote_id,
        label_normalized,
        label_display,
        status,
        buyer_kind,
        buyer_wallet_address_normalized,
        chain_ref,
        price_cents,
        currency,
        policy_version,
        quote_ttl_seconds,
        quoted_at,
        expires_at,
        claimed_at,
        funding_tx_ref,
        settlement_tx_ref,
        settings_snapshot_json,
        created_at,
        updated_at
      ) VALUES (?1, ?2, ?3, 'claimed', 'wallet', ?4, ?5, 500, 'USD', 'test', 900, ?6, ?6, ?6, '0xtest', '0xtest', NULL, ?6, ?6)
    `,
    args: [
      `pnq_${input.id}`,
      input.label.replace(/\.pirate$/u, ""),
      input.label.endsWith(".pirate") ? input.label : `${input.label}.pirate`,
      input.buyerWallet.toLowerCase(),
      chainRef,
      now,
    ],
  })
  await input.ctx.client.execute({
    sql: `
      INSERT INTO pirate_name_registrations (
        pirate_name_registration_id,
        pirate_name_quote_id,
        label_normalized,
        label_display,
        status,
        owner_kind,
        owner_wallet_address_normalized,
        chain_ref,
        price_paid_cents,
        currency,
        issued_at,
        expires_at,
        pirate_user_id,
        created_at,
        updated_at
      ) VALUES (?1, ?2, ?3, ?4, 'active', 'wallet', ?5, ?6, 500, 'USD', ?7, NULL, NULL, ?7, ?7)
    `,
    args: [
      `pnr_${input.id}`,
      `pnq_${input.id}`,
      input.label.replace(/\.pirate$/u, ""),
      input.label.endsWith(".pirate") ? input.label : `${input.label}.pirate`,
      input.buyerWallet.toLowerCase(),
      chainRef,
      now,
    ],
  })
}

describe("wallet identity routes", () => {
  test("resolves a wallet-owned public name without creating a profile", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const wallet = "0x2000000000000000000000000000000000000002"

    await insertWalletPublicName({
      ctx,
      buyerWallet: wallet,
      id: "wallet_identity_primary",
      label: "wallet-captain",
      issuedAt: "2026-04-01T00:00:00.000Z",
    })
    await insertWalletPublicName({
      ctx,
      buyerWallet: wallet,
      id: "wallet_identity_second",
      label: "wallet-second",
      issuedAt: "2026-04-02T00:00:00.000Z",
    })

    const response = await app.request(
      `http://pirate.test/wallet-identities/eip155:84532/${wallet}`,
      {},
      ctx.env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as {
      object: string
      chain_ref: string
      wallet_address: string
      display_label: string | null
      public_names: Array<{ label: string; owner_wallet_address: string }>
    }
    expect(body.object).toBe("wallet_identity")
    expect(body.chain_ref).toBe("eip155:84532")
    expect(body.wallet_address).toBe(wallet.toLowerCase())
    expect(body.display_label).toBe("wallet-captain.pirate")
    expect(body.public_names.map((name) => name.label)).toEqual([
      "wallet-captain.pirate",
      "wallet-second.pirate",
    ])
    expect(body.public_names[0]?.owner_wallet_address).toBe(wallet.toLowerCase())

    const profileResponse = await app.request(`http://pirate.test/public-profiles/by-wallet/${wallet}`, {}, ctx.env)
    expect(profileResponse.status).toBe(404)
  })

  test("returns a profile redirect when the wallet is attached to a profile", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const wallet = "0x3000000000000000000000000000000000000003"
    const session = await exchangeJwtWithWallet(ctx.env, "wallet-identity-attached-user", wallet)

    const response = await app.request(
      `http://pirate.test/wallet-identities/eip155:84532/${wallet}`,
      {},
      ctx.env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as {
      object: string
      profile: string
      profile_handle: string
      wallet_address: string
    }
    expect(body.object).toBe("wallet_identity_redirect")
    expect(body.profile).toBe(session.publicUserId)
    expect(body.profile_handle.endsWith(".pirate")).toBe(true)
    expect(body.wallet_address).toBe(wallet.toLowerCase())
  })

  test("rejects unsupported wallet identity chain refs", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const response = await app.request(
      "http://pirate.test/wallet-identities/solana:1/0x4000000000000000000000000000000000000004",
      {},
      ctx.env,
    )
    expect(response.status).toBe(400)
    const body = await json(response) as { code: string; message: string }
    expect(body.code).toBe("bad_request")
    expect(body.message).toBe("chain_ref is unsupported")
  })

  test("rejects invalid wallet identity addresses", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const response = await app.request(
      "http://pirate.test/wallet-identities/eip155:84532/not-a-wallet",
      {},
      ctx.env,
    )
    expect(response.status).toBe(400)
    const body = await json(response) as { code: string; message: string }
    expect(body.code).toBe("bad_request")
    expect(body.message).toBe("wallet_address is invalid")
  })

  test("returns 404 for wallets with no first-party identity records", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const response = await app.request(
      "http://pirate.test/wallet-identities/eip155:84532/0x4000000000000000000000000000000000000004",
      {},
      ctx.env,
    )
    expect(response.status).toBe(404)
    const body = await json(response) as { code: string; message: string }
    expect(body.code).toBe("not_found")
    expect(body.message).toBe("Wallet identity not found")
  })
})
