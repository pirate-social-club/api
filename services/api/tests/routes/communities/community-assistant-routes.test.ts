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

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

async function createAssistantRouteContext() {
  const ctx = await createRouteTestContext({
    CREDENTIAL_WRAP_KEY: VALID_WRAP_KEY,
    CREDENTIAL_WRAP_KEY_VERSION: "1",
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
    display_name: `Assistant ${input.subject}`,
    membership_mode: "request",
    handle_policy: { policy_template: "standard" },
  }, input.env, input.accessToken)
  expect(response.status).toBe(202)
  const body = await json(response) as { community: { id: string } }
  return body.community.id.replace(/^com_/, "")
}

async function getAssistantPolicy(input: {
  env: Env
  communityId: string
  accessToken: string
}): Promise<Response> {
  return Promise.resolve(app.request(
    `http://pirate.test/communities/${input.communityId}/assistant-policy`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
    input.env,
  ))
}

async function getAssistantModels(input: {
  env: Env
  communityId: string
  accessToken: string
}): Promise<Response> {
  return Promise.resolve(app.request(
    `http://pirate.test/communities/${input.communityId}/assistant-models`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
    input.env,
  ))
}

async function saveOpenRouterKey(input: {
  env: Env
  communityId: string
  accessToken: string
  apiKey?: string
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/assistant-credential`,
    { api_key: input.apiKey ?? "sk-or-test-route-key-1234" },
    input.env,
    input.accessToken,
  )
}

async function saveElevenLabsKey(input: {
  env: Env
  communityId: string
  accessToken: string
  apiKey?: string
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/assistant-credential/elevenlabs`,
    { api_key: input.apiKey ?? "elevenlabs-test-route-key-1234" },
    input.env,
    input.accessToken,
  )
}

async function revokeOpenRouterKey(input: {
  env: Env
  communityId: string
  accessToken: string
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/assistant-credential/revoke`,
    {},
    input.env,
    input.accessToken,
  )
}

async function revokeElevenLabsKey(input: {
  env: Env
  communityId: string
  accessToken: string
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/assistant-credential/elevenlabs/revoke`,
    {},
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

async function grantCommunityRole(input: {
  communityDbRoot: string
  communityId: string
  userId: string
  role: "admin" | "moderator"
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO community_roles (
          role_assignment_id, community_id, user_id, role, status, granted_by_user_id, granted_at, revoked_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 'active', ?3, ?5, NULL, ?5, ?5
        )
      `,
      args: [`rol_${input.communityId}_${input.userId}_${input.role}`, input.communityId, input.userId, input.role, now],
    })
  } finally {
    client.close()
  }
}

async function countPromptRevisions(input: {
  communityDbRoot: string
  communityId: string
}): Promise<number> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM community_assistant_prompt_revisions
        WHERE community_id = ?1
      `,
      args: [input.communityId],
    })
    return Number(result.rows[0]?.count ?? 0)
  } finally {
    client.close()
  }
}

async function listCredentialRows(input: {
  client: Awaited<ReturnType<typeof createAssistantRouteContext>>["client"]
  communityId: string
}): Promise<Array<Record<string, unknown>>> {
  const result = await input.client.execute({
    sql: `
      SELECT community_assistant_credential_id, encrypted_secret, key_last4, status, rotated_from
      FROM community_assistant_credentials
      WHERE community_id = ?1
      ORDER BY created_at ASC
    `,
    args: [input.communityId],
  })
  return result.rows
}

async function readElevenLabsLocalCapability(input: {
  communityDbRoot: string
  communityId: string
}): Promise<boolean | null> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: "SELECT settings_json FROM communities WHERE community_id = ?1 LIMIT 1",
      args: [input.communityId],
    })
    const raw = result.rows[0]?.settings_json
    const settings = typeof raw === "string" && raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {}
    const capabilities = settings.assistant_credential_capabilities
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
      return null
    }
    const value = (capabilities as Record<string, unknown>).elevenlabs_active
    return typeof value === "boolean" ? value : null
  } finally {
    client.close()
  }
}

describe("community assistant routes", () => {
  test("non-members cannot read assistant policy even when the assistant is enabled", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-nonmember-owner")
    const stranger = await exchangeJwt(ctx.env, "assistant-nonmember-stranger")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Nonmember",
    })
    expect((await saveOpenRouterKey({ env: ctx.env, communityId, accessToken: owner.accessToken })).status).toBe(200)
    expect((await updateAssistantPolicy({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      body: { enabled: true },
    })).status).toBe(200)

    const response = await getAssistantPolicy({ env: ctx.env, communityId, accessToken: stranger.accessToken })
    expect(response.status).toBe(404)
  })

  test("members read only public assistant fields", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-public-owner")
    const member = await exchangeJwt(ctx.env, "assistant-public-member")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Public",
    })
    await addCommunityMember(ctx.communityDbRoot, communityId, member.userId)
    await saveOpenRouterKey({ env: ctx.env, communityId, accessToken: owner.accessToken })
    await updateAssistantPolicy({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      body: {
        enabled: true,
        displayName: "Board Guide",
        systemPrompt: "Sensitive moderator-controlled prompt.",
      },
    })

    const response = await getAssistantPolicy({ env: ctx.env, communityId, accessToken: member.accessToken })
    expect(response.status).toBe(200)
    const body = await json(response) as Record<string, unknown>
    expect(body.object).toBe("community_assistant_policy_public")
    expect(body.displayName).toBe("Board Guide")
    expect(body.systemPrompt).toBeUndefined()
    expect(body.openRouterKeyStatus).toBeUndefined()
    expect(body.selectedModelId).toBeUndefined()
  })

  test("moderators can edit prompt and context settings", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-mod-edit-owner")
    const moderator = await exchangeJwt(ctx.env, "assistant-mod-edit-moderator")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Moderator",
    })
    await grantCommunityRole({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: moderator.userId,
      role: "moderator",
    })

    const response = await updateAssistantPolicy({
      env: ctx.env,
      communityId,
      accessToken: moderator.accessToken,
      body: {
        systemPrompt: "Use the rules first.",
        contextSources: {
          communityProfile: false,
          rules: false,
          referenceLinks: false,
          recentThreads: true,
          threadBodies: true,
          topComments: false,
          membershipState: true,
          moderationQueue: true,
          pinnedKnowledge: true,
        },
      },
    })
    expect(response.status).toBe(200)
    const body = await json(response) as { systemPrompt: string; contextSources: { communityProfile: boolean; rules: boolean; moderationQueue: boolean } }
    expect(body.systemPrompt).toBe("Use the rules first.")
    expect(body.contextSources.communityProfile).toBe(true)
    expect(body.contextSources.rules).toBe(true)
    expect(body.contextSources.moderationQueue).toBe(true)
  })

  test("moderators cannot save or revoke OpenRouter credentials", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-mod-key-owner")
    const moderator = await exchangeJwt(ctx.env, "assistant-mod-key-moderator")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Moderator Key",
    })
    await grantCommunityRole({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: moderator.userId,
      role: "moderator",
    })

    expect((await saveOpenRouterKey({ env: ctx.env, communityId, accessToken: moderator.accessToken })).status).toBe(403)
    expect((await revokeOpenRouterKey({ env: ctx.env, communityId, accessToken: moderator.accessToken })).status).toBe(403)
  })

  test("owners save OpenRouter credentials encrypted and receive only key status", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-save-key-owner")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Save Key",
    })
    const plaintext = "sk-or-secret-route-key-9abc"

    const response = await saveOpenRouterKey({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      apiKey: plaintext,
    })
    expect(response.status).toBe(200)
    const body = await json(response) as Record<string, unknown>
    expect(JSON.stringify(body)).not.toContain(plaintext)
    const status = body.openRouterKeyStatus as { kind: string; last4: string; connectedAt: string }
    expect(status.kind).toBe("connected")
    expect(status.last4).toBe("9abc")
    expect(typeof status.connectedAt).toBe("string")

    const rows = await listCredentialRows({ client: ctx.client, communityId })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("active")
    expect(rows[0]?.key_last4).toBe("9abc")
    expect(String(rows[0]?.encrypted_secret)).not.toBe(plaintext)
    expect(String(rows[0]?.encrypted_secret).startsWith("v1:")).toBe(true)
  })

  test("owners rotate OpenRouter credentials and keep one active key", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-rotate-key-owner")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Rotate Key",
    })

    expect((await saveOpenRouterKey({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      apiKey: "sk-or-first-route-key-1111",
    })).status).toBe(200)
    expect((await saveOpenRouterKey({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      apiKey: "sk-or-second-route-key-2222",
    })).status).toBe(200)

    const rows = await listCredentialRows({ client: ctx.client, communityId })
    expect(rows.map((row) => row.status).sort()).toEqual(["active", "revoked"])
    const active = rows.find((row) => row.status === "active")
    const revoked = rows.find((row) => row.status === "revoked")
    expect(active?.key_last4).toBe("2222")
    expect(active?.rotated_from).toBe(revoked?.community_assistant_credential_id)
  })

  test("owners can revoke OpenRouter credentials", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-revoke-key-owner")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Revoke Key",
    })
    await saveOpenRouterKey({ env: ctx.env, communityId, accessToken: owner.accessToken })

    const response = await revokeOpenRouterKey({ env: ctx.env, communityId, accessToken: owner.accessToken })
    expect(response.status).toBe(200)
    const body = await json(response) as Record<string, unknown>
    expect(body.openRouterKeyStatus).toEqual({ kind: "missing" })
    const rows = await listCredentialRows({ client: ctx.client, communityId })
    expect(rows.every((row) => row.status !== "active")).toBe(true)
  })

  test("owners save and revoke ElevenLabs credentials sync the local study capability", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-elevenlabs-capability-owner")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "ElevenLabs Capability",
    })

    expect(await readElevenLabsLocalCapability({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
    })).toBeNull()

    const saveResponse = await saveElevenLabsKey({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    expect(saveResponse.status).toBe(200)
    expect(await readElevenLabsLocalCapability({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
    })).toBe(true)

    const revokeResponse = await revokeElevenLabsKey({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    expect(revokeResponse.status).toBe(200)
    expect(await readElevenLabsLocalCapability({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
    })).toBe(false)
  })

  test("assistant policy responses never return the saved API key", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-no-secret-owner")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "No Secret",
    })
    const plaintext = "sk-or-never-return-this-key-4444"
    await saveOpenRouterKey({ env: ctx.env, communityId, accessToken: owner.accessToken, apiKey: plaintext })

    const response = await getAssistantPolicy({ env: ctx.env, communityId, accessToken: owner.accessToken })
    expect(response.status).toBe(200)
    const serialized = JSON.stringify(await json(response))
    expect(serialized).not.toContain(plaintext)
    expect(serialized).toContain("4444")
  })

  test("assistant cannot be enabled without an active OpenRouter credential", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-enable-no-key-owner")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "No Key",
    })

    const response = await updateAssistantPolicy({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      body: { enabled: true },
    })
    expect(response.status).toBe(400)
    const body = await json(response) as { message: string }
    expect(body.message).toContain("connected OpenRouter key")
  })

  test("prompt changes create prompt revision audit rows", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-prompt-audit-owner")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Prompt Audit",
    })

    expect(await countPromptRevisions({ communityDbRoot: ctx.communityDbRoot, communityId })).toBe(0)
    const promptResponse = await updateAssistantPolicy({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      body: { systemPrompt: "Audit this prompt." },
    })
    expect(promptResponse.status).toBe(200)
    expect(await countPromptRevisions({ communityDbRoot: ctx.communityDbRoot, communityId })).toBe(1)
    const limitResponse = await updateAssistantPolicy({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      body: { perUserDailyMessageCap: 30 },
    })
    expect(limitResponse.status).toBe(200)
    expect(await countPromptRevisions({ communityDbRoot: ctx.communityDbRoot, communityId })).toBe(1)
  })

  test("assistant models require an active OpenRouter key", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-models-owner")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Models",
    })

    const missing = await getAssistantModels({ env: ctx.env, communityId, accessToken: owner.accessToken })
    expect(missing.status).toBe(400)
    const originalFetch = globalThis.fetch
    const openRouterRequests: Array<{ authorization: string | null; url: string }> = []
    ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      openRouterRequests.push({
        authorization: request.headers.get("authorization"),
        url: request.url,
      })
      expect(request.url).toBe("https://openrouter.test/api/v1/models/user")
      return Response.json({
        data: [{
          architecture: {
            input_modalities: ["text"],
            modality: "text->text",
            output_modalities: ["text"],
          },
          context_length: 1_000_000,
          created: 1_780_000_000,
          description: "Newest model from OpenRouter.",
          id: "provider/new-model",
          name: "Provider New Model",
          pricing: {
            completion: "0.0000008",
            prompt: "0.0000002",
          },
        }, {
          architecture: {
            input_modalities: ["image"],
            modality: "image->image",
            output_modalities: ["image"],
          },
          id: "provider/image-only",
          name: "Image Only",
        }],
      })
    }
    try {
      await saveOpenRouterKey({ env: ctx.env, communityId, accessToken: owner.accessToken })
      const connected = await getAssistantModels({ env: {
        ...ctx.env,
        OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      }, communityId, accessToken: owner.accessToken })
      expect(connected.status).toBe(200)
      const body = await json(connected) as {
        object: string
        data: Array<{
          contextLength?: number
          createdAt?: string
          description?: string
          id: string
          inputCostUsdPerMillionTokens?: number
          label: string
          outputCostUsdPerMillionTokens?: number
        }>
      }
      expect(body.object).toBe("list")
      expect(body.data).toEqual([{
        contextLength: 1_000_000,
        description: "Newest model from OpenRouter.",
        id: "provider/new-model",
        inputCostUsdPerMillionTokens: 0.2,
        label: "Provider New Model",
        outputCostUsdPerMillionTokens: 0.8,
        createdAt: new Date(1_780_000_000 * 1000).toISOString(),
      }])
      expect(openRouterRequests).toEqual([{
        authorization: "Bearer sk-or-test-route-key-1234",
        url: "https://openrouter.test/api/v1/models/user",
      }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("assistant policy validation rejects oversized system prompts", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-oversized-owner")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Oversized",
    })

    const response = await updateAssistantPolicy({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      body: { systemPrompt: "x".repeat(8001) },
    })
    expect(response.status).toBe(400)
    const body = await json(response) as { message: string }
    expect(body.message).toContain("systemPrompt")
  })

  test("assistant policy validation rejects more than five starter prompts", async () => {
    const ctx = await createAssistantRouteContext()
    const owner = await exchangeJwt(ctx.env, "assistant-starter-prompts-owner")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      subject: "Starter Prompts",
    })

    const response = await updateAssistantPolicy({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      body: { starterPrompts: ["one", "two", "three", "four", "five", "six"] },
    })
    expect(response.status).toBe(400)
    const body = await json(response) as { message: string }
    expect(body.message).toContain("starterPrompts")
  })
})
