import { describe, expect, test } from "bun:test"
import app from "../../src/index"
import { buildTestEnv } from "../helpers"

describe("discovery routes", () => {
  test("GET /.well-known/jwks.json exposes the Pirate session signing key", async () => {
    const env = buildTestEnv()
    const response = await app.request("https://api.pirate.test/.well-known/jwks.json", {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")

    const body = await response.json() as {
      keys: Array<Record<string, unknown>>
    }

    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]?.kty).toBe("RSA")
    expect(body.keys[0]?.alg).toBe("RS256")
    expect(body.keys[0]?.use).toBe("sig")
    expect(body.keys[0]?.key_ops).toEqual(["verify"])
    expect(typeof body.keys[0]?.kid).toBe("string")
  })

  test("GET /.well-known/oauth-protected-resource advertises the API resource metadata", async () => {
    const env = buildTestEnv()
    const response = await app.request("https://api.pirate.test/.well-known/oauth-protected-resource", {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")

    const body = await response.json() as {
      bearer_methods_supported: string[]
      jwks_uri: string
      resource: string
      scopes_supported: string[]
    }

    expect(body.resource).toBe("https://api.pirate.test")
    expect(body.jwks_uri).toBe("https://api.pirate.test/.well-known/jwks.json")
    expect(body.bearer_methods_supported).toEqual(["header"])
    expect(body.scopes_supported).toEqual(["pirate_app_session"])
  })
})
