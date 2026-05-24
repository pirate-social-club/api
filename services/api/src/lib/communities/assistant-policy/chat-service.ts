import type { ActorContext, AdminActorContext } from "../../auth-middleware"
import { badRequestError, notFoundError, providerUnavailable, rateLimited } from "../../errors"
import { executeFirst } from "../../db-helpers"
import { makeId, nowIso } from "../../helpers"
import {
  parsePositiveIntegerEnv,
  requestOpenRouterChatCompletion,
} from "../../openrouter-client"
import { numberOrNull, rowValue, stringOrNull } from "../../sql-row"
import { openCommunityDb } from "../community-db-factory"
import { requireAssistantCommunityAccess, type CommunityAssistantRepository } from "./access"
import {
  COMMUNITY_ASSISTANT_TOOLS,
  MAX_TOOL_ROUNDS,
  MAX_TOTAL_TOOL_RESULT_CHARS,
  executeCommunityAssistantTool,
  isCommunityAssistantToolCall,
  type CommunityAssistantToolCall,
} from "./assistant-tools"
import { buildCommunityContext } from "./context-builder"
import { decryptActiveCommunityOpenRouterKey } from "./credential-service"
import {
  getCommunityAssistantRuntimePolicy,
  getCommunityAssistantRuntimePolicyForCommunity,
  type CommunityAssistantPolicy,
} from "./service"
import type { Client } from "../../sql-client"
import type { Env } from "../../../env"
import type { CommunityAssistantAudience } from "./context-builder"

const MAX_USER_MESSAGE_LENGTH = 4000
const MAX_HISTORY_MESSAGES = 12
const DEFAULT_ASSISTANT_TIMEOUT_MS = 30_000

export type CommunityAssistantChatBody = {
  message?: unknown
  chat_id?: unknown
}

export type CommunityAssistantChat = {
  id: string
  object: "community_assistant_chat"
  community: string
  user: string
  title: string | null
  status: "active" | "archived" | "deleted"
  created_at: string
  updated_at: string
}

export type CommunityAssistantMessage = {
  id: string
  object: "community_assistant_message"
  chat: string
  community: string
  user: string
  role: "user" | "assistant" | "system"
  content: string
  model_id: string | null
  provider_message_id: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  created_at: string
}

export type CommunityAssistantChatResponse = {
  object: "community_assistant_chat_response"
  chat: CommunityAssistantChat
  user_message: CommunityAssistantMessage
  assistant_message: CommunityAssistantMessage
}

export type CommunityAssistantChatListResponse = {
  object: "list"
  data: CommunityAssistantChat[]
}

export type CommunityAssistantChatDetailResponse = {
  object: "community_assistant_chat_detail"
  chat: CommunityAssistantChat
  messages: CommunityAssistantMessage[]
}

type StoredChatRow = {
  chat_id: string
  community_id: string
  user_id: string
  title: string | null
  status: "active" | "archived" | "deleted"
  created_at: string
  updated_at: string
}

type StoredMessageRow = {
  message_id: string
  chat_id: string
  community_id: string
  user_id: string
  role: "user" | "assistant" | "system"
  content: string
  model_id: string | null
  provider_message_id: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  created_at: string
}

type OpenRouterChatMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | null
  tool_calls?: CommunityAssistantToolCall[]
  tool_call_id?: string
}

type AssistantCompletionResult = {
  body: Record<string, unknown>
  completionTokens: number | null
  content: string
  promptTokens: number | null
  providerMessageId: string | null
  toolCallCount: number
  toolRounds: number
  toolsUsed: string[]
  totalTokens: number | null
}

export type CommunityAssistantGroupMessageResponse = {
  content: string
  model_id: string
  provider_message_id: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
}

function normalizeChatMessage(value: unknown): string {
  if (typeof value !== "string") {
    throw badRequestError("message is required")
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw badRequestError("message is required")
  }
  if (trimmed.length > MAX_USER_MESSAGE_LENGTH) {
    throw badRequestError(`message must be at most ${MAX_USER_MESSAGE_LENGTH} characters`)
  }
  return trimmed
}

function normalizeChatId(value: unknown): string | null {
  if (value == null) {
    return null
  }
  if (typeof value !== "string") {
    throw badRequestError("chat_id must be a string")
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  if (!/^asc_[a-zA-Z0-9]+$/.test(trimmed)) {
    throw badRequestError("chat_id is invalid")
  }
  return trimmed
}

function serializeChatRow(row: StoredChatRow): CommunityAssistantChat {
  return {
    id: row.chat_id,
    object: "community_assistant_chat",
    community: row.community_id,
    user: `usr_${row.user_id}`,
    title: row.title,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function serializeMessageRow(row: StoredMessageRow): CommunityAssistantMessage {
  return {
    id: row.message_id,
    object: "community_assistant_message",
    chat: row.chat_id,
    community: row.community_id,
    user: `usr_${row.user_id}`,
    role: row.role,
    content: row.content,
    model_id: row.model_id,
    provider_message_id: row.provider_message_id,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    total_tokens: row.total_tokens,
    created_at: row.created_at,
  }
}

function chatRow(row: unknown): StoredChatRow | null {
  if (!row || typeof row !== "object") {
    return null
  }
  const status = stringOrNull(rowValue(row, "status"))
  if (status !== "active" && status !== "archived" && status !== "deleted") {
    return null
  }
  return {
    chat_id: String(rowValue(row, "chat_id") || ""),
    community_id: String(rowValue(row, "community_id") || ""),
    user_id: String(rowValue(row, "user_id") || ""),
    title: stringOrNull(rowValue(row, "title")),
    status,
    created_at: String(rowValue(row, "created_at") || ""),
    updated_at: String(rowValue(row, "updated_at") || ""),
  }
}

function messageRow(row: unknown): StoredMessageRow | null {
  if (!row || typeof row !== "object") {
    return null
  }
  const role = stringOrNull(rowValue(row, "role"))
  if (role !== "user" && role !== "assistant" && role !== "system") {
    return null
  }
  return {
    message_id: String(rowValue(row, "message_id") || ""),
    chat_id: String(rowValue(row, "chat_id") || ""),
    community_id: String(rowValue(row, "community_id") || ""),
    user_id: String(rowValue(row, "user_id") || ""),
    role,
    content: String(rowValue(row, "content") || ""),
    model_id: stringOrNull(rowValue(row, "model_id")),
    provider_message_id: stringOrNull(rowValue(row, "provider_message_id")),
    prompt_tokens: numberOrNull(rowValue(row, "prompt_tokens")),
    completion_tokens: numberOrNull(rowValue(row, "completion_tokens")),
    total_tokens: numberOrNull(rowValue(row, "total_tokens")),
    created_at: String(rowValue(row, "created_at") || ""),
  }
}

function shouldPersistChats(policy: CommunityAssistantPolicy): boolean {
  return policy.saveChatsToCommunityDb && policy.retentionMode !== "ephemeral"
}

function titleFromMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim()
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`
}

async function getOrCreateChat(input: {
  client: Client
  communityId: string
  userId: string
  chatId: string | null
  message: string
  now: string
}): Promise<StoredChatRow> {
  if (input.chatId) {
    const existing = chatRow(await executeFirst(input.client, {
      sql: `
        SELECT chat_id, community_id, user_id, title, status, created_at, updated_at
        FROM community_assistant_chats
        WHERE community_id = ?1
          AND user_id = ?2
          AND chat_id = ?3
          AND status = 'active'
        LIMIT 1
      `,
      args: [input.communityId, input.userId, input.chatId],
    }))
    if (!existing) {
      throw notFoundError("Assistant chat not found")
    }
    return existing
  }

  const chatId = makeId("asc")
  const title = titleFromMessage(input.message)
  await input.client.execute({
    sql: `
      INSERT INTO community_assistant_chats (
        chat_id, community_id, user_id, title, status, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, 'active', ?5, ?5
      )
    `,
    args: [chatId, input.communityId, input.userId, title, input.now],
  })
  return {
    chat_id: chatId,
    community_id: input.communityId,
    user_id: input.userId,
    title,
    status: "active",
    created_at: input.now,
    updated_at: input.now,
  }
}

async function listRecentMessages(input: {
  client: Client
  chatId: string
  enabled: boolean
}): Promise<StoredMessageRow[]> {
  if (!input.enabled) {
    return []
  }
  const result = await input.client.execute({
    sql: `
      SELECT message_id, chat_id, community_id, user_id, role, content, model_id, provider_message_id,
             prompt_tokens, completion_tokens, total_tokens, created_at
      FROM community_assistant_messages
      WHERE chat_id = ?1
        AND role IN ('user', 'assistant')
      ORDER BY created_at DESC, message_id DESC
      LIMIT ?2
    `,
    args: [input.chatId, MAX_HISTORY_MESSAGES],
  })
  return result.rows.map(messageRow).filter((row): row is StoredMessageRow => Boolean(row)).reverse()
}

async function insertMessage(input: {
  client: Client
  chatId: string
  communityId: string
  userId: string
  role: StoredMessageRow["role"]
  content: string
  modelId?: string | null
  providerMessageId?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  totalTokens?: number | null
  metadata?: Record<string, unknown> | null
  now: string
}): Promise<StoredMessageRow> {
  const row: StoredMessageRow = {
    message_id: makeId("asm"),
    chat_id: input.chatId,
    community_id: input.communityId,
    user_id: input.userId,
    role: input.role,
    content: input.content,
    model_id: input.modelId ?? null,
    provider_message_id: input.providerMessageId ?? null,
    prompt_tokens: input.promptTokens ?? null,
    completion_tokens: input.completionTokens ?? null,
    total_tokens: input.totalTokens ?? null,
    created_at: input.now,
  }
  await input.client.execute({
    sql: `
      INSERT INTO community_assistant_messages (
        message_id, chat_id, community_id, user_id, role, content, model_id, provider_message_id,
        prompt_tokens, completion_tokens, total_tokens, metadata_json, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
        ?9, ?10, ?11, ?12, ?13
      )
    `,
    args: [
      row.message_id,
      row.chat_id,
      row.community_id,
      row.user_id,
      row.role,
      row.content,
      row.model_id,
      row.provider_message_id,
      row.prompt_tokens,
      row.completion_tokens,
      row.total_tokens,
      input.metadata ? JSON.stringify(input.metadata) : null,
      row.created_at,
    ],
  })
  await input.client.execute({
    sql: `
      UPDATE community_assistant_chats
      SET updated_at = ?2
      WHERE chat_id = ?1
    `,
    args: [input.chatId, input.now],
  })
  return row
}

async function enforceRuntimeLimits(input: {
  client: Client
  communityId: string
  userId: string
  policy: CommunityAssistantPolicy
  now: Date
}): Promise<void> {
  if (input.policy.perUserDailyMessageCap != null) {
    const since = new Date(input.now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const row = await executeFirst(input.client, {
      sql: `
        SELECT COUNT(*) AS count
        FROM community_assistant_messages
        WHERE community_id = ?1
          AND user_id = ?2
          AND role = 'user'
          AND created_at >= ?3
      `,
      args: [input.communityId, input.userId, since],
    })
    const count = numberOrNull(rowValue(row, "count")) ?? 0
    if (count >= input.policy.perUserDailyMessageCap) {
      throw rateLimited("Community assistant daily message limit reached")
    }
  }

}

function usageValue(body: Record<string, unknown>, key: "prompt_tokens" | "completion_tokens" | "total_tokens"): number | null {
  const usage = body.usage
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null
  }
  return numberOrNull((usage as Record<string, unknown>)[key])
}

function providerMessageId(body: Record<string, unknown>): string | null {
  const id = body.id
  return typeof id === "string" && id.trim() ? id : null
}

function responseToolCalls(body: Record<string, unknown>): CommunityAssistantToolCall[] {
  const choices = Array.isArray(body.choices) ? body.choices : []
  const first = choices[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return []
  }
  const message = (first as { message?: unknown }).message
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return []
  }
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls
  return Array.isArray(toolCalls)
    ? toolCalls.filter(isCommunityAssistantToolCall)
    : []
}

function toolUnsupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /http_400/i.test(error.message) && /tool|function|unsupported|parameter|provider|model/i.test(error.message)
}

function openRouterTimeoutMs(env: Env): number {
  return parsePositiveIntegerEnv(env.OPENROUTER_TIMEOUT_MS) ?? DEFAULT_ASSISTANT_TIMEOUT_MS
}

async function requestAssistantCompletion(input: {
  apiKey: string
  baseUrl?: string | null
  messages: OpenRouterChatMessage[]
  model: string
  timeoutMs: number
  toolChoice?: "auto" | "none"
  toolsEnabled: boolean
}) {
  return requestOpenRouterChatCompletion({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
    errorLabel: "community assistant",
    body: {
      model: input.model,
      messages: input.messages,
      ...(input.toolsEnabled ? {
        tools: COMMUNITY_ASSISTANT_TOOLS,
        tool_choice: input.toolChoice ?? "auto",
        parallel_tool_calls: false,
      } : {}),
    },
  })
}

async function runCommunityAssistantCompletion(input: {
  apiKey: string
  audience: CommunityAssistantAudience
  baseUrl?: string | null
  client: Client
  communityId: string
  messages: OpenRouterChatMessage[]
  model: string
  policy: CommunityAssistantPolicy
  timeoutMs: number
  userId: string | null
}): Promise<AssistantCompletionResult> {
  const messages = [...input.messages]
  let toolRounds = 0
  let toolCallCount = 0
  let totalToolResultChars = 0
  const toolsUsed = new Set<string>()

  let completion = await requestAssistantCompletion({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    messages,
    model: input.model,
    timeoutMs: input.timeoutMs,
    toolsEnabled: true,
  }).catch(async (error) => {
    if (!toolUnsupportedError(error)) {
      throw error
    }
    return requestAssistantCompletion({
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      messages,
      model: input.model,
      timeoutMs: input.timeoutMs,
      toolChoice: "none",
      toolsEnabled: false,
    })
  })

  while (toolRounds < MAX_TOOL_ROUNDS) {
    const toolCall = responseToolCalls(completion.body)[0]
    if (!toolCall) {
      return {
        body: completion.body,
        completionTokens: usageValue(completion.body, "completion_tokens"),
        content: completion.content,
        promptTokens: usageValue(completion.body, "prompt_tokens"),
        providerMessageId: providerMessageId(completion.body),
        toolCallCount,
        toolRounds,
        toolsUsed: [...toolsUsed],
        totalTokens: usageValue(completion.body, "total_tokens"),
      }
    }

    toolRounds += 1
    toolCallCount += 1
    toolsUsed.add(toolCall.function.name)
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [toolCall],
    })

    const toolResult = totalToolResultChars >= MAX_TOTAL_TOOL_RESULT_CHARS
      ? {
        name: toolCall.function.name,
        content: JSON.stringify({
          error: "tool_budget_exhausted",
          message: "Tool result budget exhausted for this turn.",
        }),
      }
      : await executeCommunityAssistantTool({
        audience: input.audience,
        client: input.client,
        communityId: input.communityId,
        policy: input.policy,
        toolCall,
        userId: input.userId,
      })
    const remaining = Math.max(0, MAX_TOTAL_TOOL_RESULT_CHARS - totalToolResultChars)
    const content = toolResult.content.length <= remaining
      ? toolResult.content
      : `${toolResult.content.slice(0, Math.max(0, remaining - 24)).trimEnd()}... [tool budget truncated]`
    totalToolResultChars += content.length
    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content,
    })

    completion = await requestAssistantCompletion({
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      messages,
      model: input.model,
      timeoutMs: input.timeoutMs,
      toolsEnabled: true,
    })
  }

  completion = await requestAssistantCompletion({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    messages: [
      ...messages,
      {
        role: "system",
        content: "Tool-call limit reached for this turn. Answer the user using the available conversation and tool results without calling more tools.",
      },
    ],
    model: input.model,
    timeoutMs: input.timeoutMs,
    toolChoice: "none",
    toolsEnabled: true,
  })

  return {
    body: completion.body,
    completionTokens: usageValue(completion.body, "completion_tokens"),
    content: completion.content,
    promptTokens: usageValue(completion.body, "prompt_tokens"),
    providerMessageId: providerMessageId(completion.body),
    toolCallCount,
    toolRounds,
    toolsUsed: [...toolsUsed],
    totalTokens: usageValue(completion.body, "total_tokens"),
  }
}

export async function sendCommunityAssistantMessage(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: ActorContext | AdminActorContext
  body: CommunityAssistantChatBody | null
}): Promise<CommunityAssistantChatResponse> {
  await requireAssistantCommunityAccess(input)
  const message = normalizeChatMessage(input.body?.message)
  const requestedChatId = normalizeChatId(input.body?.chat_id)
  const policy = await getCommunityAssistantRuntimePolicy(input)
  const openRouterKey = await decryptActiveCommunityOpenRouterKey({
    env: input.env,
    communityId: input.communityId,
  })
  const nowDate = new Date()
  const now = nowIso()
  const persist = shouldPersistChats(policy)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    if (persist) {
      await enforceRuntimeLimits({
        client: db.client,
        communityId: input.communityId,
        userId: input.actor.userId,
        policy,
        now: nowDate,
      })
    }

    const chat = persist
      ? await getOrCreateChat({
        client: db.client,
        communityId: input.communityId,
        userId: input.actor.userId,
        chatId: requestedChatId,
        message,
        now,
      })
      : {
        chat_id: makeId("asc"),
        community_id: input.communityId,
        user_id: input.actor.userId,
        title: titleFromMessage(message),
        status: "active" as const,
        created_at: now,
        updated_at: now,
      }
    const history = persist
      ? await listRecentMessages({
        client: db.client,
        chatId: chat.chat_id,
        enabled: policy.memoryEnabled,
      })
      : []
    const context = await buildCommunityContext({
      client: db.client,
      communityId: input.communityId,
      message,
      userId: input.actor.userId,
      policy,
      audience: "private_user",
    })
    const userMessage = persist
      ? await insertMessage({
        client: db.client,
        chatId: chat.chat_id,
        communityId: input.communityId,
        userId: input.actor.userId,
        role: "user",
        content: message,
        now,
      })
      : {
        message_id: makeId("asm"),
        chat_id: chat.chat_id,
        community_id: input.communityId,
        user_id: input.actor.userId,
        role: "user" as const,
        content: message,
        model_id: null,
        provider_message_id: null,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        created_at: now,
      }

    const openRouterMessages: OpenRouterChatMessage[] = [
      {
        role: "system",
        content: `${policy.systemPrompt}\n\n${context}`,
      },
      ...history.map((item) => ({
        role: item.role as "user" | "assistant",
        content: item.content,
      })),
      {
        role: "user",
        content: message,
      },
    ]

    const completion = await runCommunityAssistantCompletion({
      apiKey: openRouterKey,
      audience: "private_user",
      baseUrl: input.env.OPENROUTER_BASE_URL,
      client: db.client,
      communityId: input.communityId,
      messages: openRouterMessages,
      model: policy.selectedModelId,
      policy,
      timeoutMs: openRouterTimeoutMs(input.env),
      userId: input.actor.userId,
    }).catch((error) => {
      throw providerUnavailable(error instanceof Error ? error.message : "OpenRouter community assistant request failed")
    })

    const assistantNow = nowIso()
    const assistantMessage = persist
      ? await insertMessage({
        client: db.client,
        chatId: chat.chat_id,
        communityId: input.communityId,
        userId: input.actor.userId,
        role: "assistant",
        content: completion.content,
        modelId: policy.selectedModelId,
        providerMessageId: completion.providerMessageId,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        totalTokens: completion.totalTokens,
        metadata: {
          provider: "openrouter",
          action_mode: policy.actionMode,
          tool_rounds: completion.toolRounds,
          tool_call_count: completion.toolCallCount,
          tools_used: completion.toolsUsed,
        },
        now: assistantNow,
      })
      : {
        message_id: makeId("asm"),
        chat_id: chat.chat_id,
        community_id: input.communityId,
        user_id: input.actor.userId,
        role: "assistant" as const,
        content: completion.content,
        model_id: policy.selectedModelId,
        provider_message_id: completion.providerMessageId,
        prompt_tokens: completion.promptTokens,
        completion_tokens: completion.completionTokens,
        total_tokens: completion.totalTokens,
        created_at: assistantNow,
      }

    return {
      object: "community_assistant_chat_response",
      chat: serializeChatRow({
        ...chat,
        updated_at: persist ? assistantNow : chat.updated_at,
      }),
      user_message: serializeMessageRow(userMessage),
      assistant_message: serializeMessageRow(assistantMessage),
    }
  } finally {
    db.close()
  }
}

export async function sendCommunityAssistantGroupMessage(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  message: string
}): Promise<CommunityAssistantGroupMessageResponse> {
  const message = normalizeChatMessage(input.message)
  const policy = await getCommunityAssistantRuntimePolicyForCommunity({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
  })
  const groupPolicy: CommunityAssistantPolicy = {
    ...policy,
    actionMode: "answer_only",
  }
  const openRouterKey = await decryptActiveCommunityOpenRouterKey({
    env: input.env,
    communityId: input.communityId,
  })
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const context = await buildCommunityContext({
      client: db.client,
      communityId: input.communityId,
      message,
      userId: null,
      policy: groupPolicy,
      audience: "public_group",
    })
    const completion = await requestOpenRouterChatCompletion({
      apiKey: openRouterKey,
      baseUrl: input.env.OPENROUTER_BASE_URL,
      timeoutMs: openRouterTimeoutMs(input.env),
      errorLabel: "community assistant",
      body: {
        model: groupPolicy.selectedModelId,
        messages: [
          {
            role: "system",
            content: `${groupPolicy.systemPrompt}\n\n${context}`,
          },
          {
            role: "user",
            content: message,
          },
        ],
      },
    }).catch((error) => {
      throw providerUnavailable(error instanceof Error ? error.message : "OpenRouter community assistant request failed")
    })

    return {
      content: completion.content,
      model_id: groupPolicy.selectedModelId,
      provider_message_id: providerMessageId(completion.body),
      prompt_tokens: usageValue(completion.body, "prompt_tokens"),
      completion_tokens: usageValue(completion.body, "completion_tokens"),
      total_tokens: usageValue(completion.body, "total_tokens"),
    }
  } finally {
    db.close()
  }
}

export async function listCommunityAssistantChats(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: ActorContext | AdminActorContext
}): Promise<CommunityAssistantChatListResponse> {
  await requireAssistantCommunityAccess(input)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const result = await db.client.execute({
      sql: `
        SELECT chat_id, community_id, user_id, title, status, created_at, updated_at
        FROM community_assistant_chats
        WHERE community_id = ?1
          AND user_id = ?2
          AND status = 'active'
        ORDER BY updated_at DESC, chat_id DESC
        LIMIT 50
      `,
      args: [input.communityId, input.actor.userId],
    })
    return {
      object: "list",
      data: result.rows
        .map(chatRow)
        .filter((row): row is StoredChatRow => Boolean(row))
        .map(serializeChatRow),
    }
  } finally {
    db.close()
  }
}

export async function getCommunityAssistantChat(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: ActorContext | AdminActorContext
  chatId: string
}): Promise<CommunityAssistantChatDetailResponse> {
  await requireAssistantCommunityAccess(input)
  const chatId = normalizeChatId(input.chatId)
  if (!chatId) {
    throw notFoundError("Assistant chat not found")
  }
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const chat = chatRow(await executeFirst(db.client, {
      sql: `
        SELECT chat_id, community_id, user_id, title, status, created_at, updated_at
        FROM community_assistant_chats
        WHERE community_id = ?1
          AND user_id = ?2
          AND chat_id = ?3
          AND status = 'active'
        LIMIT 1
      `,
      args: [input.communityId, input.actor.userId, chatId],
    }))
    if (!chat) {
      throw notFoundError("Assistant chat not found")
    }

    const result = await db.client.execute({
      sql: `
        SELECT message_id, chat_id, community_id, user_id, role, content, model_id, provider_message_id,
               prompt_tokens, completion_tokens, total_tokens, created_at
        FROM community_assistant_messages
        WHERE chat_id = ?1
        ORDER BY created_at ASC, message_id ASC
      `,
      args: [chatId],
    })

    return {
      object: "community_assistant_chat_detail",
      chat: serializeChatRow(chat),
      messages: result.rows
        .map(messageRow)
        .filter((row): row is StoredMessageRow => Boolean(row))
        .map(serializeMessageRow),
    }
  } finally {
    db.close()
  }
}
