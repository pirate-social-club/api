import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"

import { createLocalHnsVerifierServer } from "../scripts/serve-local-hns-verifier"
import { createLocalOpenRouterProxyServer } from "../scripts/serve-local-openrouter-proxy"

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

async function listen(server: Server): Promise<string> {
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

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

describe("local HNS verifier", () => {
  test("serves the namespace verification endpoints", async () => {
    const origin = await listen(createLocalHnsVerifierServer())

    const inspect = await readJson(await fetch(`${origin}/inspect?root_label=local-open-workshop`))
    expect(inspect.root_label).toBe("local-open-workshop")
    expect(inspect.root_control_verified).toBe(true)
    expect(inspect.observation_provider).toBe("local_hns_verifier")

    const ensureZone = await readJson(await fetch(`${origin}/ensure-zone`, {
      body: JSON.stringify({ root_label: "local-open-workshop" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    expect(ensureZone.zone_name).toBe("local-open-workshop")

    const publishTxt = await readJson(await fetch(`${origin}/publish-txt`, {
      body: JSON.stringify({
        challenge_txt_value: "pirate-test-token",
        root_label: "local-open-workshop",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    expect(publishTxt.challenge_txt_value).toBe("pirate-test-token")

    const verifyTxt = await readJson(await fetch(`${origin}/verify-txt`, {
      body: JSON.stringify({
        challenge_txt_value: "pirate-test-token",
        root_label: "local-open-workshop",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    expect(verifyTxt.verified).toBe(true)
    expect(verifyTxt.observed_values).toEqual(["pirate-test-token"])
  })
})

describe("local OpenRouter proxy", () => {
  test("forwards JSON responses through the /api/v1 prefix", async () => {
    const upstream = await listen(createServer((req, res) => {
      expect(req.url).toBe("/chat/completions")
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true }))
    }))
    const proxy = await listen(createLocalOpenRouterProxyServer({ upstreamBaseUrl: upstream }))

    const response = await fetch(`${proxy}/api/v1/chat/completions`, { method: "POST" })
    expect(response.status).toBe(200)
    expect(await readJson(response)).toEqual({ ok: true })
  })

  test("converts non-JSON upstream responses to a JSON 502", async () => {
    const upstream = await listen(createServer((_req, res) => {
      res.statusCode = 503
      res.setHeader("content-type", "text/html")
      res.end("<html>unavailable</html>")
    }))
    const proxy = await listen(createLocalOpenRouterProxyServer({ upstreamBaseUrl: upstream }))

    const response = await fetch(`${proxy}/api/v1/chat/completions`, { method: "POST" })
    expect(response.status).toBe(502)
    const body = await readJson(response)
    expect((body.error as { message: string }).message).toContain("OpenRouter proxy received non-JSON response")
  })
})
