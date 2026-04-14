import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import app from "../src/index"
import type { Env } from "../src/types"
import { readDevVarsFromCwd } from "./_lib/dev-vars"

const port = Number(process.env.PORT || "8787")
const env = {
  ...readDevVarsFromCwd(),
  ...process.env,
} as Env

async function readRequestBody(req: IncomingMessage): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }

  if (chunks.length === 0) {
    return null
  }

  return Buffer.concat(chunks)
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item)
      }
      continue
    }
    if (value != null) {
      headers.set(key, value)
    }
  }

  const rawBody = req.method === "GET" || req.method === "HEAD"
    ? null
    : await readRequestBody(req)
  const body: BodyInit | undefined = rawBody ? new ReadableStream({
    start(controller) {
      controller.enqueue(rawBody)
      controller.close()
    },
  }) : undefined

  return new Request(`http://${req.headers.host || `127.0.0.1:${port}`}${req.url || "/"}`, {
    method: req.method,
    headers,
    body,
  })
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })
  const body = Buffer.from(await response.arrayBuffer())
  res.end(body)
}

const server = createServer(async (req, res) => {
  try {
    const request = await toRequest(req)
    const response = await app.fetch(request, env as never)
    await writeResponse(res, response)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeResponse(res, new Response(JSON.stringify({
      code: "internal_error",
      message,
    }), {
      status: 500,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    }))
  }
})

server.listen(port, "127.0.0.1", () => {
  console.log(`pirate-api local node server listening on http://127.0.0.1:${port}`)
})
