import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { Env } from "../env"
import { errorResponse } from "../lib/errors"
import gateCapabilities, { resetGateCapabilityRateLimitForTests } from "./gate-capabilities"

afterEach(() => resetGateCapabilityRateLimitForTests())

function app() {
  const app = new Hono<{ Bindings: Env }>()
  app.onError((error, c) => {
    const response = errorResponse(error)
    return c.json(response.body, response.status as 400)
  })
  app.route("/gate-capabilities", gateCapabilities)
  return app
}

const adminEnv = { PIRATE_ADMIN_TOKEN: "admin-secret" } as Env
const adminHeaders = {
  "x-admin-token": "admin-secret",
  "x-admin-as-user-id": "usr_test",
}

describe("gate capability routes", () => {
  test("requires authentication", async () => {
    const response = await app().request("/gate-capabilities/nft/sources", {}, adminEnv)
    expect(response.status).toBe(401)
    const assets = await app().request("/gate-capabilities/assets", {}, adminEnv)
    expect(assets.status).toBe(401)
  })

  test("lists canonical balance assets with authoring metadata when every transport is configured", async () => {
    const env = { ...adminEnv, ETHEREUM_RPC_URL: "https://eth.example", BASE_MAINNET_RPC_URL: "https://base.example" } as Env
    const response = await app().request("/gate-capabilities/assets", { headers: adminHeaders }, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      assets: [
        { asset_id: "eip155:1/slip44:60", label: "ETH on Ethereum", chain_namespace: "eip155:1", standard: "native", symbol: "ETH", decimals: 18 },
        { asset_id: "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", label: "USDC on Ethereum", chain_namespace: "eip155:1", standard: "erc20", symbol: "USDC", decimals: 6 },
        { asset_id: "eip155:8453/slip44:60", label: "ETH on Base", chain_namespace: "eip155:8453", standard: "native", symbol: "ETH", decimals: 18 },
        { asset_id: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", label: "USDC on Base", chain_namespace: "eip155:8453", standard: "erc20", symbol: "USDC", decimals: 6 },
      ],
    })
  })

  test("omits assets whose chain transport is not configured in this environment", async () => {
    // Advertising an asset this deployment cannot evaluate would let a moderator
    // author a gate that fails closed for every member.
    const env = { ...adminEnv, ETHEREUM_RPC_URL: "https://eth.example" } as Env
    const response = await app().request("/gate-capabilities/assets", { headers: adminHeaders }, env)
    expect(response.status).toBe(200)
    const body = await response.json() as { assets: Array<{ asset_id: string }> }
    expect(body.assets.map((asset) => asset.asset_id)).toEqual([
      "eip155:1/slip44:60",
      "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    ])
  })

  test("returns an empty catalog rather than unevaluable assets when no transport is configured", async () => {
    const response = await app().request("/gate-capabilities/assets", { headers: adminHeaders }, adminEnv)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ assets: [] })
  })

  test("lists stable trusted sources for an authenticated actor", async () => {
    const response = await app().request("/gate-capabilities/nft/sources", { headers: adminHeaders }, adminEnv)
    expect(response.status).toBe(200)
    const body = await response.json() as { sources: Array<{ id: string }> }
    expect(body.sources.map(({ id }) => id)).toEqual([
      "courtyard-graded-cards-ethereum",
      "courtyard-watches-ethereum",
      "courtyard-graded-cards-polygon",
      "courtyard-watches-polygon",
    ])
  })

  test("rejects unknown sources and invalid bounds before calling Courtyard", async () => {
    const missing = await app().request("/gate-capabilities/nft/sources/unknown/facets/subject/values", { headers: adminHeaders }, adminEnv)
    expect(missing.status).toBe(404)

    const invalidLimit = await app().request("/gate-capabilities/nft/sources/courtyard-graded-cards-ethereum/facets/subject/values?limit=51", { headers: adminHeaders }, adminEnv)
    expect(invalidLimit.status).toBe(400)
  })
})
