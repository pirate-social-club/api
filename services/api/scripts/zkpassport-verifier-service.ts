import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { installGracefulHttpShutdown } from "./_lib/graceful-http-shutdown"
import { ZKPassport, type ProofResult, type Query, type QueryResult } from "@zkpassport/sdk"

const DEFAULT_PORT = 8794
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024

type VerifyRequestBody = {
  domain: string
  proofs: ProofResult[]
  originalQuery: Query
  queryResult: QueryResult
  validity?: number
  scope?: string
  devMode?: boolean
}

type VerifyRequestContext = {
  requestId: string
  startedAt: number
}

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? ""
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(trimEnv(name))
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  })
}

function makeRequestId(): string {
  return `zkv_${crypto.randomUUID().replace(/-/gu, "")}`
}

function logVerifierEvent(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({
    event,
    service: "zkpassport-verifier",
    ...details,
  }))
}

function logVerifierWarning(event: string, details: Record<string, unknown>): void {
  console.warn(JSON.stringify({
    event,
    service: "zkpassport-verifier",
    ...details,
  }))
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? ""
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function readVerifyRequestBody(value: unknown): VerifyRequestBody | null {
  if (!isRecord(value)) return null
  if (typeof value.domain !== "string" || !value.domain.trim()) return null
  if (!Array.isArray(value.proofs)) return null
  if (!isRecord(value.originalQuery)) return null
  if (!isRecord(value.queryResult)) return null
  if (value.validity !== undefined && !Number.isInteger(value.validity)) return null
  if (value.scope !== undefined && typeof value.scope !== "string") return null
  if (value.devMode !== undefined && typeof value.devMode !== "boolean") return null

  return {
    domain: value.domain.trim(),
    proofs: value.proofs as ProofResult[],
    originalQuery: value.originalQuery as Query,
    queryResult: value.queryResult as QueryResult,
    ...(typeof value.validity === "number" ? { validity: value.validity } : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
    ...(typeof value.devMode === "boolean" ? { devMode: value.devMode } : {}),
  }
}

async function handleVerify(request: Request, context: VerifyRequestContext): Promise<Response> {
  const sharedSecret = trimEnv("ZKPASSPORT_VERIFIER_SHARED_SECRET")
  if (sharedSecret && !constantTimeEqual(bearerToken(request), sharedSecret)) {
    logVerifierWarning("zkpassport.verify.rejected", {
      request_id: context.requestId,
      reason: "unauthorized",
      latency_ms: Date.now() - context.startedAt,
    })
    return jsonResponse({ code: "unauthorized", message: "Unauthorized" }, 401)
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0")
  const maxBodyBytes = numberEnv("ZKPASSPORT_VERIFIER_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    logVerifierWarning("zkpassport.verify.rejected", {
      request_id: context.requestId,
      reason: "payload_too_large",
      content_length: contentLength,
      latency_ms: Date.now() - context.startedAt,
    })
    return jsonResponse({ code: "payload_too_large", message: "Request body is too large" }, 413)
  }

  const body = readVerifyRequestBody(await request.json().catch(() => null))
  if (!body) {
    logVerifierWarning("zkpassport.verify.rejected", {
      request_id: context.requestId,
      reason: "bad_request",
      latency_ms: Date.now() - context.startedAt,
    })
    return jsonResponse({ code: "bad_request", message: "Invalid ZKPassport verification request" }, 400)
  }

  logVerifierEvent("zkpassport.verify.started", {
    request_id: context.requestId,
    domain: body.domain,
    scope: body.scope ?? null,
    dev_mode: body.devMode ?? false,
    proof_count: body.proofs.length,
    content_length: Number.isFinite(contentLength) ? contentLength : null,
  })
  const zkPassport = new ZKPassport(body.domain)
  const result = await zkPassport.verify({
    proofs: body.proofs,
    originalQuery: body.originalQuery,
    queryResult: body.queryResult,
    validity: body.validity,
    scope: body.scope,
    devMode: body.devMode,
    writingDirectory: trimEnv("ZKPASSPORT_VERIFIER_WRITING_DIRECTORY") || "/tmp",
  })

  logVerifierEvent("zkpassport.verify.completed", {
    request_id: context.requestId,
    verified: result.verified,
    has_unique_identifier: Boolean(result.uniqueIdentifier),
    has_query_result_errors: Boolean(result.queryResultErrors),
    latency_ms: Date.now() - context.startedAt,
  })
  return jsonResponse({
    verified: result.verified,
    uniqueIdentifier: result.uniqueIdentifier ?? null,
    uniqueIdentifierType: result.uniqueIdentifierType ?? null,
    queryResultErrors: result.queryResultErrors ?? null,
  })
}

const port = numberEnv("ZKPASSPORT_VERIFIER_PORT", numberEnv("PORT", DEFAULT_PORT))
const hostname = trimEnv("HOST") || "127.0.0.1"

async function readRequestBody(req: IncomingMessage): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : null
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item)
      }
    } else if (value != null) {
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

  return new Request(`http://${req.headers.host || `${hostname}:${port}`}${req.url || "/"}`, {
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
  res.end(Buffer.from(await response.arrayBuffer()))
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true })
  }
  if (request.method === "POST" && url.pathname === "/verify") {
    const context = {
      requestId: makeRequestId(),
      startedAt: Date.now(),
    }
    return handleVerify(request, context).catch((error) => {
      logVerifierWarning("zkpassport.verify.failed", {
        request_id: context.requestId,
        error: error instanceof Error ? error.message : String(error),
        latency_ms: Date.now() - context.startedAt,
      })
      return jsonResponse({
        code: "verification_failed",
        message: error instanceof Error ? error.message : "ZKPassport verification failed",
      }, 502)
    })
  }
  return jsonResponse({ code: "not_found", message: "Not found" }, 404)
}

const server = createServer(async (req, res) => {
  const maxBodyBytes = numberEnv("ZKPASSPORT_VERIFIER_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)
  const contentLength = Number(req.headers["content-length"] ?? "0")
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    await writeResponse(res, jsonResponse({ code: "payload_too_large", message: "Request body is too large" }, 413))
    return
  }

  try {
    await writeResponse(res, await handleRequest(await toRequest(req)))
  } catch (error) {
    await writeResponse(res, jsonResponse({
      code: "internal_error",
      message: error instanceof Error ? error.message : "Internal server error",
    }, 500))
  }
})

installGracefulHttpShutdown(server, { service: "zkpassport verifier" })

server.listen(port, hostname, () => {
  console.log(`zkpassport verifier listening on http://${hostname}:${port}`)
})
