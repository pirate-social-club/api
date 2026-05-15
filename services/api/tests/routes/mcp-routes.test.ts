import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { solveChallenge, type Challenge, type Payload } from "altcha-lib"
import { deriveKey } from "altcha-lib/algorithms/pbkdf2"
import { app } from "../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { createAltchaChallenge } from "../../src/lib/verification/altcha-provider"
import {
  addCommunityMember,
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
} from "./communities/community-routes-test-helpers"

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

async function mcpCall(env: Record<string, unknown>, body: unknown, accessToken?: string): Promise<Response> {
  return app.request(
    "https://api.pirate.test/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  )
}

describe("mcp routes", () => {
  test("create_post returns canonical post links", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.test",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "mcp-create-post-links-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: "MCP Create Post Links",
        membership_mode: "request",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      },
      ctx.env,
      creator.accessToken,
    )
    expect(communityCreate.status).toBe(202)
    const communityBody = await json(communityCreate) as {
      community: { id: string }
    }
    const rawCommunityId = communityBody.community.id.replace(/^com_/, "")
    await addCommunityMember(ctx.communityDbRoot, rawCommunityId, creator.userId)

    const response = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: "create-post-links",
      method: "tools/call",
      params: {
        name: "create_post",
        arguments: {
          community_id: communityBody.community.id,
          title: "MCP canonical links",
          body: "The MCP write response should include human-facing links.",
          idempotency_key: "mcp-create-post-canonical-links",
        },
      },
    }, creator.accessToken)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      result?: {
        content?: Array<{ text?: string }>
        structuredContent?: {
          post?: { id?: string }
          links?: { canonical?: { href?: string } }
        }
      }
    }
    const postId = body.result?.structuredContent?.post?.id
    expect(postId).toMatch(/^post_/)
    expect(body.result?.structuredContent?.links?.canonical?.href).toBe(`https://pirate.test/p/${postId}`)
    expect(body.result?.content?.[0]?.text).toContain(`https://pirate.test/p/${postId}`)
  })

  test("find_pirate_boards can filter for proof-of-work boards", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.sc",
    })
    cleanup = ctx.cleanup
    const creator = await exchangeJwt(ctx.env, "mcp-pow-board-discovery-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const displayName = "MCP PoW Board Discovery Static"
    const description = "Boards discovered through MCP should include enough context to choose safely."
    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: displayName,
        description,
        membership_mode: "gated",
        gate_policy: { version: 1, expression: { op: "gate", gate: { type: "altcha_pow" } } },
        accepted_agent_ownership_providers: ["clawkey"],
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      },
      ctx.env,
      creator.accessToken,
    )
    expect(communityCreate.status).toBe(202)
    const communityBody = await json(communityCreate) as {
      community: { id: string; route_slug: string | null }
    }

    const rulesResponse = await app.request(
      `http://pirate.test/communities/${communityBody.community.id.replace(/^com_/, "")}/rules`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          rules: [
            {
              title: "Keep discovery relevant",
              body: "Agents should read the board before posting.",
            },
          ],
        }),
      },
      ctx.env,
    )
    expect(rulesResponse.status).toBe(200)

    const response = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: "pow-board-discovery",
      method: "tools/call",
      params: {
        name: "find_pirate_boards",
        arguments: {
          query: displayName,
          limit: 1,
          requires_pow: true,
        },
      },
    })
    expect(response.status).toBe(200)
    const body = await json(response) as {
      result: {
        structuredContent: {
          boards: Array<{
            display_name: string
            description: string | null
            namespace_verification: string | null
            route_slug: string | null
            links: { canonical: { href: string; type: string } }
            rules: Array<{ title: string; body: string | null }>
            accepted_agent_ownership_providers: string[]
            membership_gate_summaries: Array<{ gate_type: string }>
          }>
        }
      }
    }
    expect(body.result.structuredContent.boards[0]?.display_name).toBe(displayName)
    expect(body.result.structuredContent.boards[0]?.description).toBe(description)
    expect(body.result.structuredContent.boards[0]?.namespace_verification).toMatch(/^nv_[a-f0-9]+$/)
    expect(body.result.structuredContent.boards[0]?.links.canonical.href).toBe(`https://staging.pirate.sc/c/${communityBody.community.route_slug}`)
    expect(body.result.structuredContent.boards[0]?.rules.map((rule) => rule.title)).toEqual(["Keep discovery relevant"])
    expect(body.result.structuredContent.boards[0]?.accepted_agent_ownership_providers).toEqual(["clawkey"])
    expect(body.result.structuredContent.boards[0]?.membership_gate_summaries).toContainEqual({
      gate_type: "altcha_pow",
    })
  })

  test("guest comment flow: prepare, solve ALTCHA, reply, and reject replay", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.sc",
      ALTCHA_HMAC_SECRET: "test-altcha-secret",
      ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
      ALTCHA_POW_COST: "1",
      ALTCHA_POW_COUNTER_MIN: "1",
      ALTCHA_POW_COUNTER_MAX: "2",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "mcp-guest-flow-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: "MCP Guest PoW Smoke",
        membership_mode: "gated",
        gate_policy: { version: 1, expression: { op: "gate", gate: { type: "altcha_pow" } } },
        allow_anonymous_identity: true,
        anonymous_identity_scope: "community_stable",
        guest_comment_policy: "altcha_required",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      },
      ctx.env,
      creator.accessToken,
    )
    expect(communityCreate.status).toBe(202)
    const communityBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityBody.community.id
    const rawCommunityId = communityId.replace(/^com_/, "")

    await addCommunityMember(ctx.communityDbRoot, rawCommunityId, creator.userId)

    // Solve ALTCHA for post creation in gated community
    const postChallenge = await createAltchaChallenge({
      env: ctx.env,
      actorUserId: creator.userId,
      scope: "post_create",
      action: `community:${communityId}`,
    })
    const postSolution = await solveChallenge({ challenge: postChallenge, deriveKey })
    if (!postSolution) {
      throw new Error("Post ALTCHA challenge did not solve")
    }
    const postAltchaPayload = btoa(JSON.stringify({ challenge: postChallenge, solution: postSolution } satisfies Payload))

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "text",
        title: "MCP guest comment target",
        body: "This post is for testing MCP guest replies.",
        idempotency_key: "mcp-guest-flow-post-1",
        altcha: postAltchaPayload,
      },
      ctx.env,
      creator.accessToken,
    )
    expect(postCreate.status).toBe(201)
    const postBody = await json(postCreate) as { id: string }
    const postId = postBody.id

    const guestId = "test-guest-mcp-1"

    const capabilitiesResponse = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: "capabilities",
      method: "tools/call",
      params: {
        name: "get_pirate_board_capabilities",
        arguments: {
          community_id: communityId,
        },
      },
    })
    expect(capabilitiesResponse.status).toBe(200)
    const capabilitiesResult = await json(capabilitiesResponse) as {
      result?: {
        structuredContent?: {
          board?: {
            display_name?: string
            links?: { canonical?: { href?: string } }
          }
          capabilities?: {
            write?: {
              guest_comment?: { allowed?: boolean; requires?: string[] }
              delegated_agent_top_level_post?: { allowed?: boolean; accepted_ownership_providers?: string[] }
            }
          }
        }
      }
    }
    expect(capabilitiesResult.result?.structuredContent?.board?.display_name).toBe("MCP Guest PoW Smoke")
    expect(capabilitiesResult.result?.structuredContent?.board?.links?.canonical?.href).toBeDefined()
    expect(capabilitiesResult.result?.structuredContent?.capabilities?.write?.guest_comment).toMatchObject({
      allowed: true,
      requires: ["altcha"],
    })
    expect(capabilitiesResult.result?.structuredContent?.capabilities?.write?.delegated_agent_top_level_post).toMatchObject({
      allowed: false,
      accepted_ownership_providers: ["clawkey"],
    })

    const prepareResponse = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "prepare_guest_comment",
        arguments: {
          guest_id: guestId,
          community_id: communityId,
          post_id: postId,
        },
      },
    })
    expect(prepareResponse.status).toBe(200)
    const prepareResult = await json(prepareResponse) as {
      result?: {
        structuredContent?: {
          challenge: Challenge
          scope: string
          action: string
        }
      }
    }
    const challenge = prepareResult.result?.structuredContent?.challenge
    expect(challenge).toBeDefined()
    if (!challenge) {
      throw new Error("ALTCHA challenge was not returned")
    }
    expect(prepareResult.result?.structuredContent?.scope).toBe("comment_create")

    const solution = await solveChallenge({ challenge, deriveKey })
    if (!solution) {
      throw new Error("ALTCHA challenge did not solve")
    }
    const altchaPayload = btoa(JSON.stringify({ challenge, solution } satisfies Payload))

    const replyResponse = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "reply",
        arguments: {
          authorship_mode: "guest",
          guest_id: guestId,
          community_id: communityId,
          post_id: postId,
          body: "Hello from MCP guest flow",
          idempotency_key: "reply1",
          altcha: altchaPayload,
        },
      },
    })
    expect(replyResponse.status).toBe(200)
    const replyResult = await json(replyResponse) as {
      result?: {
        content?: Array<{ text?: string }>
        structuredContent?: {
          comment?: { id: string }
          post?: { id?: string; links?: { canonical?: { href?: string } } }
          links?: { canonical?: { href?: string } }
        }
      }
      error?: { message: string; code?: number }
    }
    expect(replyResult.error).toBeUndefined()
    const commentId = replyResult.result?.structuredContent?.comment?.id
    expect(commentId).toBeDefined()
    expect(replyResult.result?.structuredContent?.post?.id).toBe(postId)
    expect(replyResult.result?.structuredContent?.post?.links?.canonical?.href).toBe(`https://staging.pirate.sc/p/${postId}`)
    expect(replyResult.result?.structuredContent?.links?.canonical?.href).toBe(`https://staging.pirate.sc/p/${postId}?comment=${commentId}`)
    expect(replyResult.result?.content?.[0]?.text).toContain(`https://staging.pirate.sc/p/${postId}?comment=${commentId}`)

    const replayResponse = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "reply",
        arguments: {
          authorship_mode: "guest",
          guest_id: guestId,
          community_id: communityId,
          post_id: postId,
          body: "Replayed guest reply",
          idempotency_key: "mcp-guest-reply-replay",
          altcha: altchaPayload,
        },
      },
    })
    expect(replayResponse.status).toBe(200)
    const replayResult = await json(replayResponse) as {
      error?: { message: string }
    }
    expect(replayResult.error).toBeDefined()
    expect(replayResult.error?.message).toContain("replayed")
  })

  test("guest reply is rejected when community disallows guest comments", async () => {
    const ctx = await createRouteTestContext({
      ALTCHA_HMAC_SECRET: "test-altcha-secret",
      ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
      ALTCHA_POW_COST: "1",
      ALTCHA_POW_COUNTER_MIN: "1",
      ALTCHA_POW_COUNTER_MAX: "2",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "mcp-guest-disallowed-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: "MCP Guest Disallowed",
        membership_mode: "request",
        allow_anonymous_identity: true,
        anonymous_identity_scope: "community_stable",
        guest_comment_policy: "disallow",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      },
      ctx.env,
      creator.accessToken,
    )
    expect(communityCreate.status).toBe(202)
    const communityBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityBody.community.id
    const rawCommunityId = communityId.replace(/^com_/, "")

    await addCommunityMember(ctx.communityDbRoot, rawCommunityId, creator.userId)

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "text",
        title: "Post for disallowed guest test",
        body: "Body",
        idempotency_key: "mcp-guest-disallowed-post-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(postCreate.status).toBe(201)
    const postBody = await json(postCreate) as { id: string }

    const prepareResponse = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "prepare_guest_comment",
        arguments: {
          guest_id: "test-guest-disallowed",
          community_id: communityId,
          post_id: postBody.id,
        },
      },
    })
    expect(prepareResponse.status).toBe(200)
    const prepareResult = await json(prepareResponse) as {
      error?: { message: string; data?: { details?: { error?: string; hint?: string } } }
    }
    expect(prepareResult.error?.message).toContain("Guest comments are not enabled")
    expect(prepareResult.error?.data?.details?.error).toBe("guest_comments_disallowed")
    expect(prepareResult.error?.data?.details?.hint).toContain("get_pirate_board_capabilities")
  })

  test("guest comment on non-gated community requires and verifies ALTCHA", async () => {
    const ctx = await createRouteTestContext({
      ALTCHA_HMAC_SECRET: "test-altcha-secret",
      ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
      ALTCHA_POW_COST: "1",
      ALTCHA_POW_COUNTER_MIN: "1",
      ALTCHA_POW_COUNTER_MAX: "2",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "mcp-guest-nongated-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: "MCP Guest Non-Gated",
        membership_mode: "request",
        allow_anonymous_identity: true,
        anonymous_identity_scope: "community_stable",
        guest_comment_policy: "altcha_required",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      },
      ctx.env,
      creator.accessToken,
    )
    expect(communityCreate.status).toBe(202)
    const communityBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityBody.community.id
    const rawCommunityId = communityId.replace(/^com_/, "")

    await addCommunityMember(ctx.communityDbRoot, rawCommunityId, creator.userId)

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "text",
        title: "Post for non-gated guest test",
        body: "Body",
        idempotency_key: "mcp-guest-nongated-post-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(postCreate.status).toBe(201)
    const postBody = await json(postCreate) as { id: string }
    const postId = postBody.id

    const guestId = "test-guest-nongated-1"

    // prepare_guest_comment
    const prepareResponse = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "prepare_guest_comment",
        arguments: {
          guest_id: guestId,
          community_id: communityId,
          post_id: postId,
        },
      },
    })
    expect(prepareResponse.status).toBe(200)
    const prepareResult = await json(prepareResponse) as {
      result?: {
        structuredContent?: {
          challenge: Challenge
          scope: string
          action: string
        }
      }
    }
    const challenge = prepareResult.result?.structuredContent?.challenge
    expect(challenge).toBeDefined()
    if (!challenge) {
      throw new Error("ALTCHA challenge was not returned")
    }

    // Solve ALTCHA
    const solution = await solveChallenge({ challenge, deriveKey })
    if (!solution) {
      throw new Error("ALTCHA challenge did not solve")
    }
    const altchaPayload = btoa(JSON.stringify({ challenge, solution } satisfies Payload))

    // Guest reply with valid ALTCHA succeeds
    const replyResponse = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "reply",
        arguments: {
          authorship_mode: "guest",
          guest_id: guestId,
          community_id: communityId,
          post_id: postId,
          body: "Guest reply on non-gated community",
          idempotency_key: "reply2",
          altcha: altchaPayload,
        },
      },
    })
    expect(replyResponse.status).toBe(200)
    const replyResult = await json(replyResponse) as {
      result?: {
        structuredContent?: { comment?: { id: string } }
      }
      error?: { message: string }
    }
    expect(replyResult.error).toBeUndefined()
    expect(replyResult.result?.structuredContent?.comment?.id).toBeDefined()

    // Replay fails
    const replayResponse = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "reply",
        arguments: {
          authorship_mode: "guest",
          guest_id: guestId,
          community_id: communityId,
          post_id: postId,
          body: "Replayed guest reply",
          idempotency_key: "mcp-guest-nongated-replay",
          altcha: altchaPayload,
        },
      },
    })
    expect(replayResponse.status).toBe(200)
    const replayResult = await json(replayResponse) as {
      error?: { message: string }
    }
    expect(replayResult.error).toBeDefined()
    expect(replayResult.error?.message).toContain("replayed")

    // Guest reply without ALTCHA fails
    const noAltchaResponse = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "reply",
        arguments: {
          authorship_mode: "guest",
          guest_id: guestId,
          community_id: communityId,
          post_id: postId,
          body: "Guest reply without ALTCHA",
          idempotency_key: "mcp-guest-nongated-no-altcha",
        },
      },
    })
    expect(noAltchaResponse.status).toBe(200)
    const noAltchaResult = await json(noAltchaResponse) as {
      error?: { message: string }
    }
    expect(noAltchaResult.error).toBeDefined()
    expect(noAltchaResult.error?.message).toContain("ALTCHA proof is required")
  })
})
