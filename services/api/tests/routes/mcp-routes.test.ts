import { sign as signWithPrivateKey } from "node:crypto"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { solveChallenge, type Challenge, type Payload } from "altcha-lib"
import { deriveKey } from "altcha-lib/algorithms/pbkdf2"
import { app } from "../../src/index"
import {
  canonicalizeAgentActionProofSignaturePayload,
  computeAgentActionProofHash,
} from "../../src/lib/agents/agent-action-proof"
import { setClawkeyProviderForTests } from "../../src/lib/agents/clawkey-provider"
import { createAltchaChallenge } from "../../src/lib/verification/altcha-provider"
import { setSelfProviderForTests } from "../../src/lib/verification/self-provider"
import { buildVerifiedSelfProvider, createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { createSignedAgentChallenge } from "../agent-test-helpers"
import {
  addCommunityMember,
  completeUniqueHumanVerification,
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
  updateLocalCommunityAgentPostingPolicy,
} from "./communities/community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
  setSelfProviderForTests(buildVerifiedSelfProvider("self-mcp-routes-test-ref"))
})

afterEach(async () => {
  setClawkeyProviderForTests(null)
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

  test("delegated agent tokens can create posts through MCP and reject nonce replay", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.test",
    })
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "mcp-delegated-agent-post-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)

    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: "MCP Delegated Agent Posting Club",
        membership_mode: "request",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      },
      ctx.env,
      owner.accessToken,
    )
    expect(communityCreate.status).toBe(202)
    const communityBody = await json(communityCreate) as {
      community: { id: string }
    }
    const rawCommunityId = communityBody.community.id.replace(/^com_/, "")

    await updateLocalCommunityAgentPostingPolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId: rawCommunityId,
      agentPostingPolicy: "allow",
      agentPostingScope: "top_level_and_replies",
      acceptedAgentOwnershipProviders: ["clawkey"],
    })

    const member = await exchangeJwt(ctx.env, "mcp-delegated-agent-post-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, rawCommunityId, member.userId)

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-mcp-delegated-post",
      deviceId: "claw-device-mcp-delegated-post",
    })
    const { privateKey } = registerChallenge

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_mcp_delegated_post_123",
        registrationUrl: "https://clawkey.test/register/cks_mcp_delegated_post_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-mcp-delegated-post",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const ownershipStart = await requestJson(
      "http://pirate.test/agent-ownership-sessions",
      {
        session_kind: "register",
        ownership_provider: "clawkey",
        display_name: "MCP Delegated Captain Bot",
        agent_challenge: registerChallenge.challenge,
      },
      ctx.env,
      member.accessToken,
    )
    expect(ownershipStart.status).toBe(201)
    const ownershipStartBody = await json(ownershipStart) as {
      agent_ownership_session_id: string
    }

    const ownershipComplete = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${ownershipStartBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      member.accessToken,
    )
    expect(ownershipComplete.status).toBe(200)
    const ownershipCompleteBody = await json(ownershipComplete) as {
      agent_id: string
      resolved_agent_ownership_record_id: string
    }

    const issueResponse = await requestJson(
      `http://pirate.test/agents/${ownershipCompleteBody.agent_id}/credential`,
      {
        current_ownership_record_id: ownershipCompleteBody.resolved_agent_ownership_record_id,
      },
      ctx.env,
      member.accessToken,
    )
    expect(issueResponse.status).toBe(200)
    const issueBody = await json(issueResponse) as { access_token: string }

    const createUrl = `https://api.pirate.test/communities/${rawCommunityId}/posts`
    async function signCreatePostPayload(payload: Record<string, unknown>, nonce: string) {
      const canonicalRequestHash = await computeAgentActionProofHash({
        method: "POST",
        url: createUrl,
        body: payload,
      })
      const signedAt = new Date().toISOString()
      const signature = signWithPrivateKey(
        null,
        Buffer.from(canonicalizeAgentActionProofSignaturePayload({
          nonce,
          signedAt,
          canonicalRequestHash,
        }), "utf8"),
        privateKey,
      ).toString("base64")
      return {
        nonce,
        signed_at: signedAt,
        canonical_request_hash: canonicalRequestHash,
        signature,
      }
    }

    const createPayload = {
      post_type: "text" as const,
      title: "MCP Delegated Captain Bot says hi",
      body: "Created through MCP with a delegated agent credential.",
      idempotency_key: "mcp-delegated-agent-post-key-1",
      authorship_mode: "user_agent" as const,
      agent_id: ownershipCompleteBody.agent_id,
    }
    const createProof = await signCreatePostPayload(createPayload, "mcp-delegated-agent-post-nonce-1")
    const createdPost = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: "delegated-agent-create-post",
      method: "tools/call",
      params: {
        name: "create_post",
        arguments: {
          community_id: rawCommunityId,
          ...createPayload,
          agent_action_proof: createProof,
        },
      },
    }, issueBody.access_token)
    expect(createdPost.status).toBe(200)
    const createdBody = await json(createdPost) as {
      error?: { message?: string; data?: { code?: string } }
      result?: {
        content?: Array<{ text?: string }>
        structuredContent?: {
          post?: { id?: string; authorship_mode?: string; agent?: string | null }
          links?: { canonical?: { href?: string } }
        }
      }
    }
    expect(createdBody.error).toBeUndefined()
    const post = createdBody.result?.structuredContent?.post
    expect(post?.id).toMatch(/^post_/)
    expect(post?.authorship_mode).toBe("user_agent")
    expect(post?.agent).toBe(`agt_${ownershipCompleteBody.agent_id}`)
    expect(createdBody.result?.structuredContent?.links?.canonical?.href).toBe(`https://pirate.test/p/${post?.id}`)
    expect(createdBody.result?.content?.[0]?.text).toContain(`https://pirate.test/p/${post?.id}`)

    const replayPayload = {
      ...createPayload,
      title: "MCP Delegated Captain Bot nonce replay",
      idempotency_key: "mcp-delegated-agent-post-key-2",
    }
    const replayProof = await signCreatePostPayload(replayPayload, "mcp-delegated-agent-post-nonce-1")
    const replayPost = await mcpCall(ctx.env, {
      jsonrpc: "2.0",
      id: "delegated-agent-create-post-replay",
      method: "tools/call",
      params: {
        name: "create_post",
        arguments: {
          community_id: rawCommunityId,
          ...replayPayload,
          agent_action_proof: replayProof,
        },
      },
    }, issueBody.access_token)
    expect(replayPost.status).toBe(200)
    const replayBody = await json(replayPost) as {
      error?: { message?: string; data?: { code?: string } }
    }
    expect(replayBody.error?.data?.code).toBe("conflict")
    expect(replayBody.error?.message).toContain("nonce")
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
