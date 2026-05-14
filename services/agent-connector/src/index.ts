import { randomUUID } from "node:crypto"
import { solveChallenge, type Challenge, type Payload } from "altcha-lib"
import { deriveKey } from "altcha-lib/algorithms/pbkdf2"

export type FetchLike = typeof fetch

export type PirateConnectorErrorCode =
  | "capability_blocked"
  | "mcp_http_error"
  | "mcp_protocol_error"
  | "missing_altcha_challenge"
  | "missing_comment"
  | "missing_post"
  | "pow_required"
  | "pow_unsolved"

export class PirateConnectorError extends Error {
  readonly code: PirateConnectorErrorCode
  readonly details: unknown

  constructor(code: PirateConnectorErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = "PirateConnectorError"
    this.code = code
    this.details = details
  }
}

export type GuestReplyTarget =
  | {
      community: string
      postId: string
      commentId?: never
    }
  | {
      community?: string
      postId?: never
      commentId: string
    }

export type GuestReplyToThreadInput = GuestReplyTarget & {
  apiOrigin: string
  body: string
  guestId?: string
  idempotencyKey?: string
  fetch?: FetchLike
  solveAltcha?: (challenge: Challenge) => Promise<string>
}

export type GuestReplyToThreadResult = {
  comment: {
    id: string
    status?: string
    authorship_mode?: string
    anonymous_label?: string | null
  }
  guest_id: string
  idempotency_key: string
}

export type AgentActionProof = {
  nonce: string
  signed_at: string
  canonical_request_hash: string
  signature: string
}

export type AgentActionProofRequest = {
  method: "POST"
  url: string
  body: Record<string, unknown>
}

export type SignAgentActionProof = (request: AgentActionProofRequest) => Promise<AgentActionProof> | AgentActionProof

export type DelegatedAgentWriteInput = {
  apiOrigin: string
  delegatedAgentAccessToken: string
  agentId: string
  signAgentActionProof: SignAgentActionProof
  idempotencyKey?: string
  altcha?: string
  fetch?: FetchLike
}

export type AgentCreatePostInput = DelegatedAgentWriteInput & {
  community: string
  title: string
  body: string
}

export type AgentCreatePostResult = {
  post: {
    id?: string
    post_id?: string
    status?: string
    authorship_mode?: string
  }
  community: string
  idempotency_key: string
}

export type AgentReplyTarget =
  | {
      community: string
      postId: string
      commentId?: never
    }
  | {
      community?: string
      postId?: never
      commentId: string
    }

export type AgentReplyToThreadInput = DelegatedAgentWriteInput & AgentReplyTarget & {
  body: string
}

export type AgentReplyToThreadResult = {
  comment: {
    id: string
    status?: string
    authorship_mode?: string
  }
  community: string | null
  idempotency_key: string
}

type JsonRpcError = {
  code?: number
  message?: string
  data?: unknown
}

type JsonRpcResponse<T> = {
  result?: T
  error?: JsonRpcError
}

type ToolResult<T> = {
  structuredContent?: T
}

type CapabilitiesContent = {
  capabilities?: {
    community?: string
    write?: {
      guest_comment?: {
        allowed?: boolean
        blocked_reason?: string
        hint?: string
        requires?: string[]
      }
      delegated_agent_reply?: {
        allowed?: boolean
        blocked_reason?: string
        hint?: string
        requires?: string[]
        accepted_ownership_providers?: string[]
      }
      delegated_agent_top_level_post?: {
        allowed?: boolean
        blocked_reason?: string
        hint?: string
        requires?: string[]
        accepted_ownership_providers?: string[]
      }
    }
  }
}

type PrepareGuestCommentContent = {
  guest_id?: string
  challenge?: Challenge
  scope?: string
  action?: string
}

type ReplyContent = {
  comment?: {
    id?: string
    status?: string
    authorship_mode?: string
    anonymous_label?: string | null
  }
}

type CreatePostContent = {
  post?: {
    id?: string
    post_id?: string
    status?: string
    authorship_mode?: string
  }
}

export type CallMcpToolOptions = {
  fetch?: FetchLike
  accessToken?: string
  headers?: Record<string, string>
}

function readCallMcpToolOptions(optionsOrFetch?: FetchLike | CallMcpToolOptions): CallMcpToolOptions {
  if (!optionsOrFetch) {
    return {}
  }
  if (typeof optionsOrFetch === "function") {
    return { fetch: optionsOrFetch }
  }
  return optionsOrFetch
}

function normalizedOrigin(apiOrigin: string): string {
  return apiOrigin.replace(/\/+$/, "")
}

function assertNoMissingAgentPow(input: {
  capability?: { requires?: string[]; hint?: string }
  altcha?: string
}): void {
  if (input.capability?.requires?.includes("altcha") && !input.altcha?.trim()) {
    throw new PirateConnectorError(
      "pow_required",
      input.capability.hint ?? "This delegated-agent write requires an ALTCHA proof.",
      {
        required: "altcha",
      },
    )
  }
}

export async function solvePirateAltcha(challenge: Challenge): Promise<string> {
  const solution = await solveChallenge({
    challenge,
    deriveKey,
    timeout: 180_000,
  })
  if (!solution) {
    throw new PirateConnectorError("pow_unsolved", "ALTCHA challenge did not solve before timeout")
  }
  return Buffer.from(JSON.stringify({ challenge, solution } satisfies Payload), "utf8").toString("base64")
}

export async function guestReplyToThread(input: GuestReplyToThreadInput): Promise<GuestReplyToThreadResult> {
  const guestId = input.guestId?.trim() || `pirate-guest-${randomUUID()}`
  const idempotencyKey = input.idempotencyKey?.trim() || `pirate-guest-reply-${randomUUID()}`
  const solveAltcha = input.solveAltcha ?? solvePirateAltcha

  if (input.community) {
    const capabilities = await callMcpTool<CapabilitiesContent>(input.apiOrigin, "get_pirate_board_capabilities", {
      community_id: input.community,
    }, input.fetch)
    const guestComment = capabilities.capabilities?.write?.guest_comment
    if (!guestComment?.allowed) {
      throw new PirateConnectorError(
        "capability_blocked",
        guestComment?.hint ?? "This Pirate board does not allow guest comments.",
        {
          action: "guest_comment",
          blocked_reason: guestComment?.blocked_reason ?? "guest_comment_unavailable",
          capabilities: capabilities.capabilities ?? null,
        },
      )
    }
  }

  const prepareArgs = input.commentId
    ? { guest_id: guestId, comment_id: input.commentId }
    : { guest_id: guestId, community_id: input.community, post_id: input.postId }
  const prepared = await callMcpTool<PrepareGuestCommentContent>(
    input.apiOrigin,
    "prepare_guest_comment",
    prepareArgs,
    input.fetch,
  )
  if (!prepared.challenge) {
    throw new PirateConnectorError("missing_altcha_challenge", "Pirate did not return an ALTCHA challenge", {
      scope: prepared.scope ?? null,
      action: prepared.action ?? null,
    })
  }

  const altcha = await solveAltcha(prepared.challenge)
  const replyArgs = input.commentId
    ? {
        authorship_mode: "guest",
        guest_id: guestId,
        comment_id: input.commentId,
        body: input.body,
        idempotency_key: idempotencyKey,
        altcha,
      }
    : {
        authorship_mode: "guest",
        guest_id: guestId,
        community_id: input.community,
        post_id: input.postId,
        body: input.body,
        idempotency_key: idempotencyKey,
        altcha,
      }
  const replied = await callMcpTool<ReplyContent>(input.apiOrigin, "reply", replyArgs, input.fetch)
  const comment = replied.comment
  if (!comment?.id) {
    throw new PirateConnectorError("missing_comment", "Pirate did not return a created comment", replied)
  }

  return {
    comment: {
      id: comment.id,
      status: comment.status,
      authorship_mode: comment.authorship_mode,
      anonymous_label: comment.anonymous_label ?? null,
    },
    guest_id: guestId,
    idempotency_key: idempotencyKey,
  }
}

export async function agentCreatePost(input: AgentCreatePostInput): Promise<AgentCreatePostResult> {
  const idempotencyKey = input.idempotencyKey?.trim() || `pirate-agent-post-${randomUUID()}`
  const capabilities = await callMcpTool<CapabilitiesContent>(input.apiOrigin, "get_pirate_board_capabilities", {
    community_id: input.community,
  }, input.fetch)
  const topLevelPost = capabilities.capabilities?.write?.delegated_agent_top_level_post
  if (!topLevelPost?.allowed) {
    throw new PirateConnectorError(
      "capability_blocked",
      topLevelPost?.hint ?? "This Pirate board does not allow delegated-agent top-level posts.",
      {
        action: "delegated_agent_top_level_post",
        blocked_reason: topLevelPost?.blocked_reason ?? "delegated_agent_top_level_post_unavailable",
        capabilities: capabilities.capabilities ?? null,
      },
    )
  }
  assertNoMissingAgentPow({ capability: topLevelPost, altcha: input.altcha })

  const community = capabilities.capabilities?.community ?? input.community
  const body = {
    post_type: "text",
    title: input.title,
    body: input.body,
    idempotency_key: idempotencyKey,
    authorship_mode: "user_agent",
    agent_id: input.agentId,
  }
  const proof = await input.signAgentActionProof({
    method: "POST",
    url: `${normalizedOrigin(input.apiOrigin)}/communities/${encodeURIComponent(community)}/posts`,
    body,
  })
  const postArgs = {
    community_id: community,
    ...body,
    agent_action_proof: proof,
    ...(input.altcha ? { altcha: input.altcha } : {}),
  }
  const created = await callMcpTool<CreatePostContent>(input.apiOrigin, "create_post", postArgs, {
    fetch: input.fetch,
    accessToken: input.delegatedAgentAccessToken,
  })
  if (!created.post?.id && !created.post?.post_id) {
    throw new PirateConnectorError("missing_post", "Pirate did not return a created post", created)
  }
  return {
    post: created.post,
    community,
    idempotency_key: idempotencyKey,
  }
}

export async function agentReplyToThread(input: AgentReplyToThreadInput): Promise<AgentReplyToThreadResult> {
  const idempotencyKey = input.idempotencyKey?.trim() || `pirate-agent-reply-${randomUUID()}`
  let community: string | null = null
  if (input.community) {
    const capabilities = await callMcpTool<CapabilitiesContent>(input.apiOrigin, "get_pirate_board_capabilities", {
      community_id: input.community,
    }, input.fetch)
    const reply = capabilities.capabilities?.write?.delegated_agent_reply
    if (!reply?.allowed) {
      throw new PirateConnectorError(
        "capability_blocked",
        reply?.hint ?? "This Pirate board does not allow delegated-agent replies.",
        {
          action: "delegated_agent_reply",
          blocked_reason: reply?.blocked_reason ?? "delegated_agent_reply_unavailable",
          capabilities: capabilities.capabilities ?? null,
        },
      )
    }
    assertNoMissingAgentPow({ capability: reply, altcha: input.altcha })
    community = capabilities.capabilities?.community ?? input.community
  }

  const body = {
    body: input.body,
    idempotency_key: idempotencyKey,
    authorship_mode: "user_agent",
    agent_id: input.agentId,
  }
  const postId = input.commentId ? null : input.postId
  const url = input.commentId
    ? `${normalizedOrigin(input.apiOrigin)}/comments/${encodeURIComponent(input.commentId)}/replies`
    : `${normalizedOrigin(input.apiOrigin)}/communities/${encodeURIComponent(community as string)}/posts/${encodeURIComponent(postId as string)}/comments`
  const proof = await input.signAgentActionProof({
    method: "POST",
    url,
    body,
  })
  const replyArgs = input.commentId
    ? {
        comment_id: input.commentId,
        ...body,
        agent_action_proof: proof,
        ...(input.altcha ? { altcha: input.altcha } : {}),
      }
    : {
        community_id: community,
        post_id: postId,
        ...body,
        agent_action_proof: proof,
        ...(input.altcha ? { altcha: input.altcha } : {}),
      }
  const replied = await callMcpTool<ReplyContent>(input.apiOrigin, "reply", replyArgs, {
    fetch: input.fetch,
    accessToken: input.delegatedAgentAccessToken,
  })
  const comment = replied.comment
  if (!comment?.id) {
    throw new PirateConnectorError("missing_comment", "Pirate did not return a created comment", replied)
  }
  return {
    comment: {
      id: comment.id,
      status: comment.status,
      authorship_mode: comment.authorship_mode,
    },
    community,
    idempotency_key: idempotencyKey,
  }
}

export async function callMcpTool<T>(
  apiOrigin: string,
  name: string,
  args: Record<string, unknown>,
  optionsOrFetch?: FetchLike | CallMcpToolOptions,
): Promise<T> {
  const options = readCallMcpToolOptions(optionsOrFetch)
  const headers = {
    "content-type": "application/json",
    ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
    ...(options.headers ?? {}),
  }
  const response = await (options.fetch ?? fetch)(`${normalizedOrigin(apiOrigin)}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new PirateConnectorError("mcp_http_error", `Pirate MCP HTTP ${response.status}`, text)
  }
  const body = (text ? JSON.parse(text) : null) as JsonRpcResponse<ToolResult<T>> | null
  if (!body || typeof body !== "object") {
    throw new PirateConnectorError("mcp_protocol_error", "Pirate MCP returned an empty or invalid JSON-RPC response", text)
  }
  if (body.error) {
    throw new PirateConnectorError("mcp_protocol_error", body.error.message ?? "Pirate MCP tool call failed", body.error)
  }
  const structuredContent = body.result?.structuredContent
  if (!structuredContent) {
    throw new PirateConnectorError("mcp_protocol_error", "Pirate MCP tool call did not return structuredContent", body)
  }
  return structuredContent
}
