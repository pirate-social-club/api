import { describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import { buildTestEnv } from "../helpers"

describe("discovery routes", () => {
  test("GET /.well-known/api-catalog advertises public structured discovery links", async () => {
    const env = buildTestEnv()
    const response = await app.request("https://api.pirate.test/.well-known/api-catalog", {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/linkset+json")
    expect(response.headers.get("link")).toContain("/.well-known/service-desc/public.openapi.json")

    const body = await response.json() as {
      links: Array<{
        href: string
        rel: string
        type: string
        auth_required: boolean
      }>
    }

    expect(body.links.map((link) => link.rel)).toContain("service-desc")
    expect(body.links.map((link) => link.rel)).toContain("mcp")
    expect(body.links.map((link) => link.rel)).toContain("agent-skills")
    expect(body.links.map((link) => link.rel)).toContain("robots")
    expect(body.links.map((link) => link.rel)).toContain("sitemap")
  })

  test("GET /robots.txt advertises public structured routes and sitemap", async () => {
    const env = buildTestEnv()
    const response = await app.request("https://api.pirate.test/robots.txt", {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/plain")

    const body = await response.text()
    expect(body).toContain("Allow: /public-communities")
    expect(body).toContain("Allow: /public-posts")
    expect(body).toContain("Sitemap: https://api.pirate.test/sitemap.xml")
  })

  test("GET /sitemap.xml bootstraps public structured discovery", async () => {
    const env = buildTestEnv()
    const response = await app.request("https://api.pirate.test/sitemap.xml", {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/xml")

    const body = await response.text()
    expect(body).toContain("<urlset")
    expect(body).toContain("https://api.pirate.test/.well-known/api-catalog")
    expect(body).toContain("https://api.pirate.test/.well-known/service-desc/public.openapi.json")
  })

  test("GET /.well-known/service-desc/public.openapi.json advertises public traversal routes", async () => {
    const env = buildTestEnv()
    const response = await app.request("https://api.pirate.test/.well-known/service-desc/public.openapi.json", {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/vnd.oai.openapi+json")

    const body = await response.json() as {
      paths: Record<string, unknown>
    }

    expect(body.paths["/public-communities/{community_id}"]).toBeTruthy()
    expect(body.paths["/public-communities/{community_id}/posts"]).toBeTruthy()
    expect(body.paths["/public-posts/{post_id}"]).toBeTruthy()
    expect(body.paths["/public-posts/{post_id}/top-comments"]).toBeTruthy()
  })

  test("GET /.well-known/mcp/server-card.json advertises the API catalog resource", async () => {
    const env = buildTestEnv()
    const response = await app.request("https://api.pirate.test/.well-known/mcp/server-card.json", {}, env)

    expect(response.status).toBe(200)
    const body = await response.json() as {
      serverInfo: { name: string }
      resources: Array<{ uri: string }>
    }

    expect(body.serverInfo.name).toBe("pirate-api")
    expect(body.resources.map((resource) => resource.uri)).toContain("https://api.pirate.test/.well-known/api-catalog")
  })

  test("GET /.well-known/agent-skills/index.json advertises public read skills", async () => {
    const env = buildTestEnv()
    const response = await app.request("https://api.pirate.test/.well-known/agent-skills/index.json", {}, env)

    expect(response.status).toBe(200)
    const body = await response.json() as {
      skills: Array<{ id: string }>
    }

    expect(body.skills.map((skill) => skill.id)).toContain("read-public-community")
    expect(body.skills.map((skill) => skill.id)).toContain("summarize-public-thread")
  })

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

  test("GET /.well-known/openid-configuration advertises OIDC discovery metadata", async () => {
    const env = buildTestEnv()
    const response = await app.request("https://api.pirate.test/.well-known/openid-configuration", {}, env)

    expect(response.status).toBe(200)
    const body = await response.json() as {
      issuer: string
      jwks_uri: string
      subject_types_supported: string[]
    }

    expect(body.issuer).toBe("https://api.pirate.test")
    expect(body.jwks_uri).toBe("https://api.pirate.test/.well-known/jwks.json")
    expect(body.subject_types_supported).toEqual(["public"])
  })
})
