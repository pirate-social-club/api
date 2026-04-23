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
      authorization_servers: string[]
      bearer_methods_supported: string[]
      jwks_uri: string
      resource: string
      scopes_supported: string[]
    }

    expect(body.resource).toBe("https://api.pirate.test")
    expect(body.authorization_servers).toEqual(["https://api.pirate.test"])
    expect(body.jwks_uri).toBe("https://api.pirate.test/.well-known/jwks.json")
    expect(body.bearer_methods_supported).toEqual(["header"])
    expect(body.scopes_supported).toEqual(["pirate_app_session"])
  })

  test("GET /.well-known/oauth-authorization-server advertises the Pirate OAuth metadata", async () => {
    const env = buildTestEnv()
    const response = await app.request("https://api.pirate.test/.well-known/oauth-authorization-server", {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")

    const body = await response.json() as {
      authorization_endpoint: string
      grant_types_supported: string[]
      issuer: string
      jwks_uri: string
      protected_resources: string[]
      token_endpoint: string
    }

    expect(body.issuer).toBe("https://api.pirate.test")
    expect(body.authorization_endpoint).toBe("https://api.pirate.test/auth/session/exchange")
    expect(body.token_endpoint).toBe("https://api.pirate.test/auth/session/exchange")
    expect(body.jwks_uri).toBe("https://api.pirate.test/.well-known/jwks.json")
    expect(body.grant_types_supported).toEqual(["urn:pirate:params:oauth:grant-type:session-exchange"])
    expect(body.protected_resources).toEqual(["https://api.pirate.test"])
  })
})
