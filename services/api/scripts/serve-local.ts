import { existsSync } from "node:fs"
import { execSync } from "node:child_process"
import { resolve } from "node:path"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import app from "../src/index"
import type { Env } from "../src/types"
import { readModeEnv, type PirateMode } from "./_lib/dev-vars"

const mode: PirateMode = (process.env.PIRATE_MODE as PirateMode) || "local-sqlite"
const port = Number(process.env.PORT || "8787")
const serviceRoot = resolve(import.meta.dirname, "..")
const env = {
  ...readModeEnv(serviceRoot, mode),
  ...process.env,
} as Env

function envFlag(value: string | undefined): boolean {
  return String(value || "").trim().toLowerCase() === "true"
}

function validateLocalSqlite(): void {
  if (envFlag(env.DEV_MEMORY_STORE_ENABLED)) {
    throw new Error(
      "DEV_MEMORY_STORE_ENABLED=true is not compatible with local-sqlite mode. "
      + "Use dev:worker for in-memory mode.",
    )
  }

  const cpUrl = String(env.CONTROL_PLANE_DATABASE_URL || "").trim()
  if (!cpUrl) {
    throw new Error("CONTROL_PLANE_DATABASE_URL is not configured")
  }
  if (cpUrl.startsWith("file:")) {
    const dbPath = new URL(cpUrl).pathname
    if (!dbPath || !existsSync(dbPath)) {
      throw new Error(
        `CONTROL_PLANE_DATABASE_URL points at a file that does not exist: ${dbPath}\n`
        + "Run `rtk bun run local:reset` to create it.",
      )
    }

    const tableCheck = execSync(
      `sqlite3 "${dbPath}" "SELECT name FROM sqlite_master WHERE type='table' AND name='communities';"`,
      { encoding: "utf8" },
    ).trim()
    if (!tableCheck) {
      throw new Error(
        `Control-plane DB exists but has no 'communities' table: ${dbPath}\n`
        + "Run `rtk bun run local:reset` to re-apply migrations.",
      )
    }
  }

  const communityRoot = String(env.LOCAL_COMMUNITY_DB_ROOT || "").trim()
  if (!communityRoot) {
    throw new Error("LOCAL_COMMUNITY_DB_ROOT is not configured")
  }
  if (!existsSync(communityRoot)) {
    throw new Error(
      `LOCAL_COMMUNITY_DB_ROOT directory does not exist: ${communityRoot}\n`
      + "Run `rtk bun run local:reset` to create it.",
    )
  }
}

function validateRemoteMode(activeMode: "staging" | "production"): void {
  if (envFlag(env.DEV_MEMORY_STORE_ENABLED)) {
    throw new Error(`DEV_MEMORY_STORE_ENABLED=true is not compatible with ${activeMode} mode.`)
  }

  const cpUrl = String(env.CONTROL_PLANE_DATABASE_URL || "").trim()
  if (!cpUrl) {
    throw new Error(`CONTROL_PLANE_DATABASE_URL is not configured for ${activeMode} mode`)
  }
  if (cpUrl.startsWith("file:")) {
    throw new Error(`CONTROL_PLANE_DATABASE_URL must not use file: URLs in ${activeMode} mode`)
  }

  const communityRoot = String(env.LOCAL_COMMUNITY_DB_ROOT || "").trim()
  if (communityRoot) {
    throw new Error(`LOCAL_COMMUNITY_DB_ROOT must be unset in ${activeMode} mode`)
  }

  if (envFlag(env.ALLOW_LOCAL_STUB_REGISTRY_PUBLICATION)) {
    throw new Error(`ALLOW_LOCAL_STUB_REGISTRY_PUBLICATION=true is not allowed in ${activeMode} mode`)
  }

  const publicOrigin = String(env.PIRATE_API_PUBLIC_ORIGIN || "").trim()
  if (publicOrigin) {
    const normalized = publicOrigin.toLowerCase()
    if (normalized.includes("localhost") || normalized.includes("127.0.0.1")) {
      throw new Error(`PIRATE_API_PUBLIC_ORIGIN must not point at localhost in ${activeMode} mode`)
    }
  }
}

function printBanner(): void {
  const cpUrl = String(env.CONTROL_PLANE_DATABASE_URL || "").trim()
  const communityRoot = mode === "local-sqlite"
    ? String(env.LOCAL_COMMUNITY_DB_ROOT || "").trim()
    : "disabled"
  const registryMode = String(env.REGISTRY_PUBLISHER_URL || "").trim()
    ? "remote"
    : (envFlag(env.ALLOW_LOCAL_STUB_REGISTRY_PUBLICATION) ? "local_stub" : "disabled")
  const hnsMode = String(env.HNS_VERIFICATION_PROVIDER || "local_stub").trim()

  const lines = [
    `pirate-api mode=${mode}`,
    `  control_plane_db = ${cpUrl}`,
    `  community_db_root = ${communityRoot}`,
    `  registry_publication = ${registryMode}`,
    `  hns_verification = ${hnsMode}`,
  ]

  console.log(lines.join("\n"))
}

if (mode === "local-sqlite") {
  validateLocalSqlite()
} else if (mode === "staging" || mode === "production") {
  validateRemoteMode(mode)
}
printBanner()

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

  const bodyBytes = req.method === "GET" || req.method === "HEAD"
    ? undefined
    : await readRequestBody(req) ?? undefined
  const body = bodyBytes
    ? new Uint8Array(bodyBytes).buffer
    : undefined

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
  console.log(`listening on http://127.0.0.1:${port}`)
})
