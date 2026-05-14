import { guestReplyToThread, PirateConnectorError } from "./index"

const DEFAULT_PORT = 8797
const MCP_PROTOCOL_VERSION = "2025-06-18"

type JsonRpcRequest = {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: {
    name?: string
    arguments?: Record<string, unknown>
  }
}

type GuestReplyToolArguments = {
  api_origin?: string
  community_id?: string
  post_id?: string
  comment_id?: string
  body?: string
  guest_id?: string
  idempotency_key?: string
}

const tools = [
  {
    name: "guest_reply_to_thread",
    description: "Create a Pirate guest comment by resolving policy, preparing an ALTCHA challenge, solving proof-of-work locally, and submitting the reply. The raw ALTCHA challenge is not exposed to the agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        api_origin: {
          type: "string",
          description: "Pirate API origin. Defaults to PIRATE_API_ORIGIN or https://api.pirate.sc.",
        },
        community_id: {
          type: "string",
          description: "Community id, public community id, /c/slug, route slug, or display name. Required for top-level post comments.",
        },
        post_id: {
          type: "string",
          description: "Post id for a top-level comment.",
        },
        comment_id: {
          type: "string",
          description: "Comment id for a nested reply. Takes precedence over post_id.",
        },
        body: {
          type: "string",
          description: "Comment body text.",
        },
        guest_id: {
          type: "string",
          description: "Optional stable opaque guest id. One is generated when omitted.",
        },
        idempotency_key: {
          type: "string",
          description: "Optional stable idempotency key. One is generated when omitted.",
        },
      },
      required: ["body"],
    },
  },
] as const

function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  })
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      data,
    },
  })
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

async function callTool(id: JsonRpcRequest["id"], args: GuestReplyToolArguments): Promise<Response> {
  const apiOrigin = readString(args.api_origin) ?? readString(process.env.PIRATE_API_ORIGIN) ?? "https://api.pirate.sc"
  const body = readString(args.body)
  const commentId = readString(args.comment_id)
  const postId = readString(args.post_id)
  const community = readString(args.community_id)
  if (!body) {
    return jsonRpcError(id, -32602, "body is required")
  }
  if (!commentId && (!community || !postId)) {
    return jsonRpcError(id, -32602, "community_id and post_id are required unless comment_id is provided")
  }

  const result = commentId
    ? await guestReplyToThread({
        apiOrigin,
        commentId,
        body,
        guestId: readString(args.guest_id),
        idempotencyKey: readString(args.idempotency_key),
      })
    : await guestReplyToThread({
        apiOrigin,
        community: community as string,
        postId: postId as string,
        body,
        guestId: readString(args.guest_id),
        idempotencyKey: readString(args.idempotency_key),
      })

  return jsonRpcResult(id, {
    content: [
      {
        type: "text",
        text: `Created Pirate guest comment ${result.comment.id}.`,
      },
    ],
    structuredContent: result,
  })
}

async function handleMcp(request: Request): Promise<Response> {
  let payload: JsonRpcRequest
  try {
    payload = await request.json() as JsonRpcRequest
  } catch {
    return jsonRpcError(null, -32700, "Invalid JSON")
  }

  try {
    if (payload.method === "initialize") {
      return jsonRpcResult(payload.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "pirate-agent-connector",
          version: "0.1.0",
        },
      })
    }
    if (payload.method === "tools/list") {
      return jsonRpcResult(payload.id, { tools })
    }
    if (payload.method === "tools/call") {
      if (payload.params?.name !== "guest_reply_to_thread") {
        return jsonRpcError(payload.id, -32601, `Unknown tool: ${payload.params?.name ?? "unknown"}`)
      }
      return await callTool(payload.id, payload.params.arguments ?? {})
    }
    return jsonRpcError(payload.id, -32601, `Unknown method: ${payload.method ?? "unknown"}`)
  } catch (error) {
    if (error instanceof PirateConnectorError) {
      return jsonRpcError(payload.id, -32000, error.message, {
        code: error.code,
        details: error.details,
      })
    }
    return jsonRpcError(payload.id, -32000, error instanceof Error ? error.message : String(error))
  }
}

const port = Number.parseInt(process.env.PORT ?? "", 10) || DEFAULT_PORT

Bun.serve({
  port,
  fetch: (request: Request) => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true })
    }
    if (request.method === "POST" && url.pathname === "/mcp") {
      return handleMcp(request)
    }
    return new Response("Not found", { status: 404 })
  },
})

console.error(`Pirate agent connector MCP listening on http://127.0.0.1:${port}/mcp`)
