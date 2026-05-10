import { Hono, type Context } from "hono"
import {
  authenticateAdminUserOrAgentDelegated,
  requireBearerToken,
  type ActorContext,
  type AdminActorContext,
} from "../lib/auth-middleware"
import { assertAgentDelegatedWriteMatchesActor } from "../lib/agents/agent-write-authorization"
import { getProfileRepository, getUserRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import { createComment } from "../lib/comments/comment-service"
import type { CreateCommentRequest } from "../lib/comments/comment-types"
import { authError, badRequestError, HttpError } from "../lib/errors"
import { COMMUNITY_MCP_TOOLS, MCP_PROTOCOL_VERSION } from "../lib/mcp/community-tools"
import { createPost } from "../lib/posts/post-service"
import { serializeComment } from "../serializers/comment"
import { serializePost } from "../serializers/post"
import type { Env } from "../env"
import type { AgentActionProof, CreatePostRequest } from "../types"
import { decodePublicCommentId, decodePublicPostId } from "../lib/public-ids"
import { readAltchaProof } from "../lib/verification/altcha-provider"

type McpJsonRpcRequest = {
  id?: string | number | null
  jsonrpc?: string
  method?: string
  params?: unknown
}

type McpToolCallParams = {
  name?: unknown
  arguments?: unknown
}

type McpCreatePostArguments = {
  community_id?: unknown
  post_type?: unknown
  title?: unknown
  body?: unknown
  idempotency_key?: unknown
  authorship_mode?: unknown
  agent_id?: unknown
  agent_action_proof?: unknown
  altcha?: unknown
}

type McpReplyArguments = {
  community_id?: unknown
  post_id?: unknown
  comment_id?: unknown
  body?: unknown
  idempotency_key?: unknown
  authorship_mode?: unknown
  agent_id?: unknown
  agent_action_proof?: unknown
  altcha?: unknown
}

const mcp = new Hono<{ Bindings: Env }>()
type McpContext = Context<{ Bindings: Env }>

function jsonRpcResult(id: McpJsonRpcRequest["id"], result: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  })
}

function jsonRpcError(id: McpJsonRpcRequest["id"], code: number, message: string, data?: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  })
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestError(message)
  }
  return value as Record<string, unknown>
}

function readRequiredString(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) {
    throw badRequestError(`${field} is required`)
  }
  return text
}

function readOptionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : ""
  return text || undefined
}

function readAgentActionProof(value: unknown): AgentActionProof | null {
  if (value == null) {
    return null
  }
  const proof = readRecord(value, "agent_action_proof is invalid")
  return {
    nonce: readRequiredString(proof.nonce, "agent_action_proof.nonce"),
    signed_at: readRequiredString(proof.signed_at, "agent_action_proof.signed_at"),
    canonical_request_hash: readRequiredString(proof.canonical_request_hash, "agent_action_proof.canonical_request_hash"),
    signature: readRequiredString(proof.signature, "agent_action_proof.signature"),
  }
}

function buildCreatePostBody(args: McpCreatePostArguments): CreatePostRequest {
  const postType = readOptionalString(args.post_type) ?? "text"
  if (postType !== "text") {
    throw badRequestError("MCP create_post currently supports text posts only")
  }
  const authorshipMode = readOptionalString(args.authorship_mode)
  const agentId = readOptionalString(args.agent_id)
  if (authorshipMode !== undefined && authorshipMode !== "human_direct" && authorshipMode !== "user_agent") {
    throw badRequestError("authorship_mode must be human_direct or user_agent")
  }
  return {
    post_type: "text",
    title: readRequiredString(args.title, "title"),
    body: readRequiredString(args.body, "body"),
    idempotency_key: readOptionalString(args.idempotency_key) ?? `mcp-create-post-${crypto.randomUUID()}`,
    ...(authorshipMode ? { authorship_mode: authorshipMode } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(args.agent_action_proof == null ? {} : { agent_action_proof: readAgentActionProof(args.agent_action_proof) }),
  }
}

function buildCreateCommentBody(args: McpReplyArguments): CreateCommentRequest {
  const authorshipMode = readOptionalString(args.authorship_mode)
  const agentId = readOptionalString(args.agent_id)
  if (authorshipMode !== undefined && authorshipMode !== "human_direct" && authorshipMode !== "user_agent") {
    throw badRequestError("authorship_mode must be human_direct or user_agent")
  }
  return {
    body: readRequiredString(args.body, "body"),
    idempotency_key: readOptionalString(args.idempotency_key) ?? `mcp-reply-${crypto.randomUUID()}`,
    ...(authorshipMode ? { authorship_mode: authorshipMode } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(args.agent_action_proof == null ? {} : { agent_action_proof: readAgentActionProof(args.agent_action_proof) }),
  }
}

async function authenticateMcpWrite(c: {
  env: Env
  req: { header(name: string): string | undefined }
}): Promise<ActorContext | AdminActorContext> {
  if (!c.req.header("authorization")) {
    throw authError("Authentication required. Sign in to Pirate or connect a delegated agent credential; no API key is required.")
  }
  // Preserve normal auth failures as auth failures while allowing delegated credentials.
  requireBearerToken(c.req.header("authorization"))
  return authenticateAdminUserOrAgentDelegated({
    allowAgentDelegated: true,
    authorization: c.req.header("authorization"),
    env: c.env,
    xAdminAsUserId: c.req.header("x-admin-as-user-id"),
    xAdminToken: c.req.header("x-admin-token"),
  })
}

async function callCreatePostTool(c: McpContext, rawArgs: unknown) {
  const args = readRecord(rawArgs, "create_post arguments are required") as McpCreatePostArguments
  const communityIdentifier = readRequiredString(args.community_id, "community_id")
  const actor = await authenticateMcpWrite(c)
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityIdentifier(communityRepository, communityIdentifier) ?? communityIdentifier
  const body = buildCreatePostBody(args)
  if (actor.authType !== "admin") {
    assertAgentDelegatedWriteMatchesActor({ actor, body })
  }

  const result = await createPost({
    env: c.env,
    requestUrl: `${new URL(c.req.url).origin}/communities/${encodeURIComponent(communityId)}/posts`,
    userId: actor.userId,
    communityId,
    body,
    bypassAuthorAccessChecks: actor.authType === "admin",
    altchaProof: readAltchaProof({
      headerValue: null,
      body: { altcha: args.altcha },
      scope: "post_create",
      action: `community:${communityId.startsWith("com_") ? communityId : `com_${communityId}`}`,
    }),
    userRepository: getUserRepository(c.env),
    profileRepository: getProfileRepository(c.env),
    communityRepository,
  })
  const post = serializePost(result)
  return {
    content: [
      {
        type: "text",
        text: `Created Pirate post ${post.id}`,
      },
    ],
    structuredContent: {
      post,
    },
  }
}

async function callReplyTool(c: McpContext, rawArgs: unknown) {
  const args = readRecord(rawArgs, "reply arguments are required") as McpReplyArguments
  const actor = await authenticateMcpWrite(c)
  const communityRepository = getCommunityRepository(c.env)
  const commentIdRaw = readOptionalString(args.comment_id)
  const postIdRaw = readOptionalString(args.post_id)
  const body = buildCreateCommentBody(args)
  if (actor.authType !== "admin") {
    assertAgentDelegatedWriteMatchesActor({ actor, body })
  }

  let communityId: string
  let threadRootPostId: string
  let parentCommentId: string | null = null
  let requestUrl: string
  let altchaAction: string

  if (commentIdRaw) {
    parentCommentId = decodePublicCommentId(commentIdRaw)
    const projection = await communityRepository.getCommunityCommentProjectionByCommentId(parentCommentId)
    if (!projection) {
      throw badRequestError("comment_id was not found")
    }
    communityId = projection.community_id
    threadRootPostId = projection.thread_root_post_id
    requestUrl = `${new URL(c.req.url).origin}/comments/${encodeURIComponent(commentIdRaw)}/replies`
    altchaAction = `comment:${commentIdRaw.startsWith("cmt_") ? commentIdRaw : `cmt_${commentIdRaw}`}`
  } else {
    const communityIdentifier = readRequiredString(args.community_id, "community_id")
    if (!postIdRaw) {
      throw badRequestError("post_id is required when comment_id is omitted")
    }
    communityId = await resolveCommunityIdentifier(communityRepository, communityIdentifier) ?? communityIdentifier
    threadRootPostId = decodePublicPostId(postIdRaw)
    requestUrl = `${new URL(c.req.url).origin}/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postIdRaw)}/comments`
    altchaAction = `post:${postIdRaw.startsWith("post_") ? postIdRaw : `post_${postIdRaw}`}`
  }

  const result = await createComment({
    env: c.env,
    requestUrl,
    userId: actor.userId,
    communityId,
    threadRootPostId,
    parentCommentId,
    body,
    bypassAuthorAccessChecks: actor.authType === "admin",
    altchaProof: readAltchaProof({
      headerValue: null,
      body: { altcha: args.altcha },
      scope: "comment_create",
      action: altchaAction,
    }),
    userRepository: getUserRepository(c.env),
    profileRepository: getProfileRepository(c.env),
    communityRepository,
  })
  const comment = serializeComment(result)
  return {
    content: [
      {
        type: "text",
        text: `Created Pirate comment ${comment.id}`,
      },
    ],
    structuredContent: {
      comment,
    },
  }
}

mcp.post("/", async (c) => {
  const request = await c.req.json<McpJsonRpcRequest>().catch(() => null)
  if (!request || request.jsonrpc !== "2.0" || !request.method) {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request")
  }

  try {
    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: {
          name: "pirate-api",
          title: "Pirate API",
          version: "0.1.0",
        },
        capabilities: {
          tools: {},
        },
      })
    }
    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, {
        tools: COMMUNITY_MCP_TOOLS,
      })
    }
    if (request.method === "tools/call") {
      const params = readRecord(request.params, "tools/call params are required") as McpToolCallParams
      if (params.name === "create_post") {
        return jsonRpcResult(request.id, await callCreatePostTool(c, params.arguments))
      }
      if (params.name === "reply") {
        return jsonRpcResult(request.id, await callReplyTool(c, params.arguments))
      }
      return jsonRpcError(request.id, -32601, "Unknown tool")
    }
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 202 })
    }
    return jsonRpcError(request.id, -32601, "Method not found")
  } catch (error) {
    const message = error instanceof HttpError && error.status === 401
      ? error.message.includes("no API key is required")
        ? error.message
        : `${error.message}; no API key is required.`
      : error instanceof Error
        ? error.message
        : "MCP request failed"
    return jsonRpcError(request.id, -32000, message)
  }
})

export default mcp
