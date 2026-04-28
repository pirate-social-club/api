import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { readDevVarsFromCwd } from "./_lib/dev-vars"

const port = Number(process.env.PIRATE_DEV_OPENROUTER_PROXY_PORT || "8792")

function resolveUpstreamBaseUrl(): string {
  const devVars = readDevVarsFromCwd()
  return String(
    process.env.PIRATE_DEV_OPENROUTER_PROXY_TARGET
      || process.env.OPENROUTER_BASE_URL
      || devVars.OPENROUTER_BASE_URL
      || "https://openrouter.ai/api/v1",
  ).trim().replace(/\/+$/u, "")
}

const hopByHopHeaders = new Set([
  "accept-encoding",
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

async function readRequestBody(req: IncomingMessage): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : null
}

function forwardHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (hopByHopHeaders.has(key.toLowerCase())) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
      continue
    }
    if (value != null) headers.set(key, value)
  }
  if (!headers.has("accept")) {
    headers.set("accept", "application/json")
  }
  return headers
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    if (!hopByHopHeaders.has(key.toLowerCase())) {
      res.setHeader(key, value)
    }
  })
  res.end(Buffer.from(await response.arrayBuffer()))
}

function toBodyInit(body: Uint8Array | null): BodyInit | null {
  if (!body) return null
  const copy = new Uint8Array(body.byteLength)
  copy.set(body)
  return copy.buffer
}

export function createLocalOpenRouterProxyServer(input: {
  upstreamBaseUrl?: string
} = {}): Server {
  const upstreamBaseUrl = (input.upstreamBaseUrl || resolveUpstreamBaseUrl()).trim().replace(/\/+$/u, "")
  return createServer(async (req, res) => {
    try {
      const requestPath = req.url || "/"
      const upstreamPath = requestPath.startsWith("/api/v1/")
        ? requestPath.slice("/api/v1".length)
        : requestPath
      const upstreamUrl = new URL(`${upstreamBaseUrl}${upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`}`)
      const body = req.method === "GET" || req.method === "HEAD" ? null : await readRequestBody(req)
      const response = await fetch(upstreamUrl, {
        body: toBodyInit(body),
        headers: forwardHeaders(req),
        method: req.method,
      })
      const contentType = response.headers.get("content-type") || ""
      if (!contentType.toLowerCase().includes("application/json")) {
        const bodyText = await response.text().catch(() => "")
        const bodyPreview = bodyText.replace(/\s+/gu, " ").trim().slice(0, 240)
        console.warn("local OpenRouter proxy received non-JSON response", {
          contentType,
          status: response.status,
          upstreamUrl: upstreamUrl.toString(),
          bodyPreview,
        })
        await writeResponse(res, Response.json({
          error: {
            message: `OpenRouter proxy received non-JSON response (${response.status} ${contentType || "unknown content-type"})`,
          },
        }, { status: 502 }))
        return
      }
      await writeResponse(res, response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await writeResponse(res, new Response(JSON.stringify({
        error: {
          message: `Local OpenRouter proxy failed: ${message}`,
        },
      }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        status: 502,
      }))
    }
  })
}

if (import.meta.main) {
  const upstreamBaseUrl = resolveUpstreamBaseUrl()
  createLocalOpenRouterProxyServer({ upstreamBaseUrl }).listen(port, "127.0.0.1", () => {
    console.log(`local OpenRouter proxy listening on http://127.0.0.1:${port}/api/v1`)
    console.log(`local OpenRouter proxy target: ${upstreamBaseUrl}`)
  })
}
