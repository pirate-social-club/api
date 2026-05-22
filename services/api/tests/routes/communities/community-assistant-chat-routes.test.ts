import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import type { Env } from "../../../src/env"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  addCommunityMember,
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./community-routes-test-helpers"

const VALID_WRAP_KEY = "0".repeat(64)

let cleanup: (() => Promise<void>) | null = null

type OpenRouterCall = {
  authorization: string | null
  body: {
    model?: string
    messages?: Array<{ role?: string; content?: string }>
  }
  url: string
}

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

async function createAssistantChatRouteContext() {
  const ctx = await createRouteTestContext({
    OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
    OPENROUTER_TIMEOUT_MS: "1000",
    TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
    TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
  })
  cleanup = ctx.cleanup
  return ctx
}

async function createTestCommunity(input: {
  env: Env
  accessToken: string
  subject: string
}): Promise<string> {
  await completeUniqueHumanVerification(input.env, input.accessToken)
  const response = await requestJson("http://pirate.test/communities", {
    display_name: `Assistant Runtime ${input.subject}`,
    membership_mode: "request",
    handle_policy: { policy_template: "standard" },
  }, input.env, input.accessToken)
  expect(response.status).toBe(202)
  const body = await json(response) as { community: { id: string } }
  return body.community.id.replace(/^com_/, "")
}

async function saveOpenRouterKey(input: {
  env: Env
  communityId: string
  accessToken: string
  apiKey?: string
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/assistant-credential`,
    { api_key: input.apiKey ?? "sk-or-runtime-route-key-1234" },
    input.env,
    input.accessToken,
  )
}

async function updateAssistantPolicy(input: {
  env: Env
  communityId: string
  accessToken: string
  body: Record<string, unknown>
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/assistant-policy`,
    input.body,
    input.env,
    input.accessToken,
  )
}

async function sendAssistantChat(input: {
  env: Env
  communityId: string
  accessToken: string
  body: Record<string, unknown>
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/assistant/chat`,
    input.body,
    input.env,
    input.accessToken,
  )
}

async function getAssistantChats(input: {
  env: Env
  communityId: string
  accessToken: string
}): Promise<Response> {
  return Promise.resolve(app.request(
    `http://pirate.test/communities/${input.communityId}/assistant/chats`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
    input.env,
  ))
}

async function getAssistantChat(input: {
  env: Env
  communityId: string
  accessToken: string
  chatId: string
}): Promise<Response> {
  return Promise.resolve(app.request(
    `http://pirate.test/communities/${input.communityId}/assistant/chats/${input.chatId}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
    input.env,
  ))
}

async function seedContextRows(input: {
  communityDbRoot: string
  communityId: string
  userId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  const now = new Date().toISOString()
  try {
    await client.batch([
      {
        sql: `
          INSERT INTO community_rules (
            rule_id, community_id, title, body, position, status, created_at, updated_at, report_reason
          ) VALUES (
            ?1, ?2, 'Be useful', 'Answer with concrete sources from the board.', 0, 'active', ?3, ?3, 'Be useful'
          )
        `,
        args: [`rule_${input.communityId}_assistant`, input.communityId, now],
      },
      {
        sql: `
          INSERT INTO posts (
            post_id, community_id, author_user_id, identity_mode, post_type, status,
            title, body, analysis_state, content_safety_state, age_gate_policy, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'public', 'text', 'published',
            'Welcome thread', 'This board is about community-owned AI assistants.',
            'allow', 'safe', 'none', ?4, ?4
          )
        `,
        args: [`pst_${input.communityId}_assistant`, input.communityId, input.userId, now],
      },
      {
        sql: `
          INSERT INTO comments (
            comment_id, community_id, thread_root_post_id, author_user_id, identity_mode,
            body, status, depth, direct_reply_count, descendant_count, upvote_count,
            downvote_count, score, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, 'public',
            'Top comment says moderators should own prompts and keys.',
            'published', 0, 0, 0, 4,
            0, 4, ?5, ?5
          )
        `,
        args: [
          `cmt_${input.communityId}_assistant`,
          input.communityId,
          `pst_${input.communityId}_assistant`,
          input.userId,
          now,
        ],
      },
    ], "write")
  } finally {
    client.close()
  }
}

async function setupEnabledAssistant(input: {
  env: Env
  communityId: string
  ownerToken: string
  apiKey?: string
  policy?: Record<string, unknown>
}): Promise<void> {
  const credential = await saveOpenRouterKey({
    env: input.env,
    communityId: input.communityId,
    accessToken: input.ownerToken,
    apiKey: input.apiKey,
  })
  expect(credential.status).toBe(200)
  const policy = await updateAssistantPolicy({
    env: input.env,
    communityId: input.communityId,
    accessToken: input.ownerToken,
    body: {
      enabled: true,
      selectedModelId: "test/community-assistant-model",
      systemPrompt: "You are the runtime community assistant.",
      maxContextThreads: 5,
      maxLookbackDays: 365,
      perUserDailyMessageCap: null,
      ...input.policy,
    },
  })
  expect(policy.status).toBe(200)
}

async function withMockedOpenRouter<T>(
  responseContent: string,
  run: (calls: OpenRouterCall[]) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  const calls: OpenRouterCall[] = []
  globalThis.fetch = (async (requestInput, init) => {
    const request = new Request(requestInput, init)
    if (request.url !== "https://openrouter.test/api/v1/chat/completions") {
      return originalFetch(request)
    }
    calls.push({
      authorization: request.headers.get("authorization"),
      body: await request.json() as OpenRouterCall["body"],
      url: request.url,
    })
    return new Response(JSON.stringify({
      id: `chatcmpl_${calls.length}`,
      choices: [{ message: { content: responseContent } }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  try {
    return await run(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe("community assistant chat routes", () => {
  test("members can chat with the enabled assistant and context is sent to OpenRouter", async () => {
    const ctx = await createAssistantChatRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-runtime-owner")
    const member = await exchangeJwt(ctx.env, "assistant-runtime-member")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Context",
    })
    await addCommunityMember(ctx.communityDbRoot, communityId, member.userId)
    await seedContextRows({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: owner.userId,
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
      apiKey: "sk-or-runtime-secret-key-7890",
    })

    await withMockedOpenRouter("Use the rules and the welcome thread.", async (calls) => {
      const response = await sendAssistantChat({
        env: ctx.env,
        communityId,
        accessToken: member.accessToken,
        body: { message: "What is this board about?" },
      })
      expect(response.status).toBe(200)
      const body = await json(response) as {
        object: string
        chat: { id: string }
        user_message: { content: string }
        assistant_message: { content: string; model_id: string; provider_message_id: string }
      }
      expect(body.object).toBe("community_assistant_chat_response")
      expect(body.user_message.content).toBe("What is this board about?")
      expect(body.assistant_message.content).toBe("Use the rules and the welcome thread.")
      expect(body.assistant_message.model_id).toBe("test/community-assistant-model")
      expect(body.assistant_message.provider_message_id).toBe("chatcmpl_1")

      expect(calls).toHaveLength(1)
      expect(calls[0]?.authorization).toBe("Bearer sk-or-runtime-secret-key-7890")
      expect(calls[0]?.body.model).toBe("test/community-assistant-model")
      const systemContent = calls[0]?.body.messages?.[0]?.content ?? ""
      expect(systemContent).toContain("You are the runtime community assistant.")
      expect(systemContent).toContain("Be useful")
      expect(systemContent).toContain("Welcome thread")
      expect(systemContent).toContain("Top comment says moderators should own prompts and keys.")
    })
  })

  test("chat history is persisted and used in follow-up OpenRouter calls", async () => {
    const ctx = await createAssistantChatRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-history-owner")
    const member = await exchangeJwt(ctx.env, "assistant-history-member")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "History",
    })
    await addCommunityMember(ctx.communityDbRoot, communityId, member.userId)
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
    })

    await withMockedOpenRouter("First answer.", async (calls) => {
      const first = await sendAssistantChat({
        env: ctx.env,
        communityId,
        accessToken: member.accessToken,
        body: { message: "First question" },
      })
      expect(first.status).toBe(200)
      const firstBody = await json(first) as { chat: { id: string } }

      const second = await sendAssistantChat({
        env: ctx.env,
        communityId,
        accessToken: member.accessToken,
        body: { chat_id: firstBody.chat.id, message: "Follow up" },
      })
      expect(second.status).toBe(200)
      expect(calls).toHaveLength(2)
      const secondMessages = calls[1]?.body.messages ?? []
      expect(secondMessages.map((message) => message.content)).toContain("First question")
      expect(secondMessages.map((message) => message.content)).toContain("First answer.")
      expect(secondMessages.at(-1)?.content).toBe("Follow up")

      const detail = await getAssistantChat({
        env: ctx.env,
        communityId,
        accessToken: member.accessToken,
        chatId: firstBody.chat.id,
      })
      expect(detail.status).toBe(200)
      const detailBody = await json(detail) as { messages: Array<{ role: string; content: string }> }
      expect(detailBody.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"])

      const list = await getAssistantChats({
        env: ctx.env,
        communityId,
        accessToken: member.accessToken,
      })
      expect(list.status).toBe(200)
      const listBody = await json(list) as { data: Array<{ id: string }> }
      expect(listBody.data.map((chat) => chat.id)).toContain(firstBody.chat.id)
    })
  })

  test("chat history is private to each user", async () => {
    const ctx = await createAssistantChatRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-private-owner")
    const firstMember = await exchangeJwt(ctx.env, "assistant-private-first")
    const secondMember = await exchangeJwt(ctx.env, "assistant-private-second")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Private",
    })
    await addCommunityMember(ctx.communityDbRoot, communityId, firstMember.userId)
    await addCommunityMember(ctx.communityDbRoot, communityId, secondMember.userId)
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
    })

    await withMockedOpenRouter("Private answer.", async () => {
      const response = await sendAssistantChat({
        env: ctx.env,
        communityId,
        accessToken: firstMember.accessToken,
        body: { message: "Private question" },
      })
      expect(response.status).toBe(200)
      const body = await json(response) as { chat: { id: string } }

      const denied = await getAssistantChat({
        env: ctx.env,
        communityId,
        accessToken: secondMember.accessToken,
        chatId: body.chat.id,
      })
      expect(denied.status).toBe(404)
    })
  })

  test("disabled assistant and non-member chat requests are rejected before OpenRouter is called", async () => {
    const ctx = await createAssistantChatRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-disabled-owner")
    const member = await exchangeJwt(ctx.env, "assistant-disabled-member")
    const stranger = await exchangeJwt(ctx.env, "assistant-disabled-stranger")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Disabled",
    })
    await addCommunityMember(ctx.communityDbRoot, communityId, member.userId)
    await saveOpenRouterKey({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })

    await withMockedOpenRouter("Should not be called", async (calls) => {
      const disabled = await sendAssistantChat({
        env: ctx.env,
        communityId,
        accessToken: member.accessToken,
        body: { message: "Can I chat?" },
      })
      expect(disabled.status).toBe(404)

      const nonMember = await sendAssistantChat({
        env: ctx.env,
        communityId,
        accessToken: stranger.accessToken,
        body: { message: "Can I chat?" },
      })
      expect(nonMember.status).toBe(404)
      expect(calls).toHaveLength(0)
    })
  })

  test("per-user daily cap is enforced before the provider call", async () => {
    const ctx = await createAssistantChatRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-cap-owner")
    const member = await exchangeJwt(ctx.env, "assistant-cap-member")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Cap",
    })
    await addCommunityMember(ctx.communityDbRoot, communityId, member.userId)
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
      policy: { perUserDailyMessageCap: 1 },
    })

    await withMockedOpenRouter("One answer.", async (calls) => {
      const first = await sendAssistantChat({
        env: ctx.env,
        communityId,
        accessToken: member.accessToken,
        body: { message: "First capped question" },
      })
      expect(first.status).toBe(200)

      const second = await sendAssistantChat({
        env: ctx.env,
        communityId,
        accessToken: member.accessToken,
        body: { message: "Second capped question" },
      })
      expect(second.status).toBe(429)
      expect(calls).toHaveLength(1)
    })
  })
})
