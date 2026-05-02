import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { app } from "../src/index"
import type { Env } from "../src/types"
import { readDevVarsFromCwd, readWranglerVarsFromCwd } from "./_lib/dev-vars"
import {
  applyLocalControlPlaneMigrations,
  ensureLocalDevStorage,
  resolveLocalDevStorage,
} from "./_lib/local-dev-storage"

const port = Number(process.env.PORT || "8787")

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

async function main(): Promise<void> {
  const wranglerEnv = readWranglerVarsFromCwd("wrangler.jsonc", "development")
  const devVars = readDevVarsFromCwd()
  const baseEnv = {
    ...wranglerEnv,
    ...devVars,
    ...process.env,
  }
  const localDevStorage = resolveLocalDevStorage(baseEnv)
  if (localDevStorage.controlPlaneDbRehomedFromPath) {
    console.warn(
      [
        "warning: CONTROL_PLANE_DATABASE_URL pointed to a missing local file;",
        `using ${localDevStorage.controlPlaneDbPath} instead of ${localDevStorage.controlPlaneDbRehomedFromPath}.`,
      ].join(" "),
    )
  }
  await ensureLocalDevStorage(localDevStorage)

  if (localDevStorage.controlPlaneDbPath) {
    await applyLocalControlPlaneMigrations(localDevStorage)
  } else {
    console.warn(
      [
        "warning: dev:local is using a remote control-plane database;",
        "local control-plane migrations will not run.",
        "Leave CONTROL_PLANE_DATABASE_URL blank to use services/api/.local/control-plane.db.",
      ].join(" "),
    )
  }

  const env = {
    ...baseEnv,
    CONTROL_PLANE_DATABASE_URL: localDevStorage.controlPlaneDbUrl,
    LOCAL_COMMUNITY_DB_ROOT: localDevStorage.communityDbRoot,
  } as Env

  const server = createServer(async (req, res) => {
    try {
      const request = await toRequest(req)
      const response = await app.fetch(request, env as never, {
        props: {},
        passThroughOnException() {},
        waitUntil() {},
      })
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
    console.log(`control-plane db: ${localDevStorage.controlPlaneDbPath ?? localDevStorage.controlPlaneDbUrl}`)
    console.log(`community db root: ${localDevStorage.communityDbRoot}`)
    const publicOrigin = String(env.PIRATE_API_PUBLIC_ORIGIN || "").trim()
    if (publicOrigin) {
      console.log(`public API origin: ${publicOrigin}`)
    }
  })
}

await main()
