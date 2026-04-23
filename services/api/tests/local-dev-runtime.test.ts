import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"

import { sanitizeLocalDevEnv } from "../scripts/_lib/local-dev-runtime"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })))
})

async function startServer(): Promise<string> {
  const server = createServer((_req, res) => {
    res.statusCode = 404
    res.end("ok")
  })
  servers.push(server)

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address")
  }

  return `http://127.0.0.1:${address.port}`
}

describe("sanitizeLocalDevEnv", () => {
  test("disables unreachable loopback community provision operator config", async () => {
    const result = await sanitizeLocalDevEnv({
      COMMUNITY_PROVISION_OPERATOR_BASE_URL: "http://127.0.0.1:65535",
      COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: "secret",
    }, {
      timeoutMs: 50,
    })

    expect(result.values.COMMUNITY_PROVISION_OPERATOR_BASE_URL).toBe("")
    expect(result.values.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN).toBe("")
    expect(result.warnings).toHaveLength(1)
  })

  test("keeps reachable loopback community provision operator config", async () => {
    const baseUrl = await startServer()
    const result = await sanitizeLocalDevEnv({
      COMMUNITY_PROVISION_OPERATOR_BASE_URL: baseUrl,
      COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: "secret",
    })

    expect(result.values.COMMUNITY_PROVISION_OPERATOR_BASE_URL).toBe(baseUrl)
    expect(result.values.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN).toBe("secret")
    expect(result.warnings).toEqual([])
  })

  test("leaves non-loopback community provision operator config untouched", async () => {
    const result = await sanitizeLocalDevEnv({
      COMMUNITY_PROVISION_OPERATOR_BASE_URL: "https://spaces.pirate.sc",
      COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: "secret",
    })

    expect(result.values.COMMUNITY_PROVISION_OPERATOR_BASE_URL).toBe("https://spaces.pirate.sc")
    expect(result.values.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN).toBe("secret")
    expect(result.warnings).toEqual([])
  })
})
