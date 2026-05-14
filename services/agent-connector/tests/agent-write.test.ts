import { describe, expect, test } from "bun:test"
import {
  agentCreatePost,
  agentReplyToThread,
  callMcpTool,
  PirateConnectorError,
  type AgentActionProofRequest,
} from "../src/index"

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  })
}

function toolResponse(structuredContent: unknown): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id: "test",
    result: {
      structuredContent,
    },
  })
}

function proofFor(requests: AgentActionProofRequest[]) {
  return async (request: AgentActionProofRequest) => {
    requests.push(request)
    return {
      nonce: "nonce_1",
      signed_at: "2026-05-13T00:00:00.000Z",
      canonical_request_hash: "hash_1",
      signature: "sig_1",
    }
  }
}

describe("delegated agent connector writes", () => {
  test("agentCreatePost gates capabilities, signs REST request, and calls hosted MCP with bearer auth", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown>; authorization: string | null }> = []
    const proofRequests: AgentActionProofRequest[] = []
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string; arguments: Record<string, unknown> }
      }
      calls.push({
        ...body.params,
        authorization: new Headers(init?.headers).get("authorization"),
      })
      if (body.params.name === "get_pirate_board_capabilities") {
        return toolResponse({
          capabilities: {
            community: "com_resolved",
            write: {
              delegated_agent_top_level_post: {
                allowed: true,
                requires: [],
                accepted_ownership_providers: ["clawkey"],
              },
            },
          },
        })
      }
      if (body.params.name === "create_post") {
        expect(body.params.arguments).toMatchObject({
          community_id: "com_resolved",
          post_type: "text",
          title: "Hello",
          body: "Body",
          idempotency_key: "idem-post",
          authorship_mode: "user_agent",
          agent_id: "agt_1",
          agent_action_proof: {
            nonce: "nonce_1",
            canonical_request_hash: "hash_1",
          },
        })
        return toolResponse({
          post: {
            id: "post_1",
            status: "published",
            authorship_mode: "user_agent",
          },
        })
      }
      throw new Error(`unexpected tool ${body.params.name}`)
    }

    const result = await agentCreatePost({
      apiOrigin: "https://api.pirate.test",
      delegatedAgentAccessToken: "delegated-token",
      agentId: "agt_1",
      community: "dankmeme",
      title: "Hello",
      body: "Body",
      idempotencyKey: "idem-post",
      fetch: fetchMock as unknown as typeof fetch,
      signAgentActionProof: proofFor(proofRequests),
    })

    expect(result.post.id).toBe("post_1")
    expect(calls.map((call) => call.name)).toEqual(["get_pirate_board_capabilities", "create_post"])
    expect(calls[0]?.authorization).toBeNull()
    expect(calls[1]?.authorization).toBe("Bearer delegated-token")
    expect(proofRequests).toEqual([
      {
        method: "POST",
        url: "https://api.pirate.test/communities/com_resolved/posts",
        body: {
          post_type: "text",
          title: "Hello",
          body: "Body",
          idempotency_key: "idem-post",
          authorship_mode: "user_agent",
          agent_id: "agt_1",
        },
      },
    ])
  })

  test("agentReplyToThread gates top-level replies and signs the REST comment URL", async () => {
    const proofRequests: AgentActionProofRequest[] = []
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string; arguments: Record<string, unknown> }
      }
      if (body.params.name === "get_pirate_board_capabilities") {
        return toolResponse({
          capabilities: {
            community: "com_resolved",
            write: {
              delegated_agent_reply: {
                allowed: true,
                requires: [],
                accepted_ownership_providers: ["clawkey"],
              },
            },
          },
        })
      }
      if (body.params.name === "reply") {
        expect(body.params.arguments).toMatchObject({
          community_id: "com_resolved",
          post_id: "post_1",
          body: "Reply body",
          idempotency_key: "idem-reply",
          authorship_mode: "user_agent",
          agent_id: "agt_1",
        })
        return toolResponse({
          comment: {
            id: "cmt_1",
            status: "published",
            authorship_mode: "user_agent",
          },
        })
      }
      throw new Error(`unexpected tool ${body.params.name}`)
    }

    const result = await agentReplyToThread({
      apiOrigin: "https://api.pirate.test",
      delegatedAgentAccessToken: "delegated-token",
      agentId: "agt_1",
      community: "dankmeme",
      postId: "post_1",
      body: "Reply body",
      idempotencyKey: "idem-reply",
      fetch: fetchMock as unknown as typeof fetch,
      signAgentActionProof: proofFor(proofRequests),
    })

    expect(result.comment.id).toBe("cmt_1")
    expect(proofRequests[0]).toMatchObject({
      method: "POST",
      url: "https://api.pirate.test/communities/com_resolved/posts/post_1/comments",
      body: {
        body: "Reply body",
        idempotency_key: "idem-reply",
        authorship_mode: "user_agent",
        agent_id: "agt_1",
      },
    })
  })

  test("agentReplyToThread supports nested comment replies", async () => {
    const calls: string[] = []
    const proofRequests: AgentActionProofRequest[] = []
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string; arguments: Record<string, unknown> }
      }
      calls.push(body.params.name)
      if (body.params.name === "reply") {
        expect(body.params.arguments).toMatchObject({
          comment_id: "cmt_parent",
          body: "Nested reply",
          authorship_mode: "user_agent",
          agent_id: "agt_1",
        })
        return toolResponse({
          comment: {
            id: "cmt_nested",
            status: "published",
            authorship_mode: "user_agent",
          },
        })
      }
      throw new Error(`unexpected tool ${body.params.name}`)
    }

    const result = await agentReplyToThread({
      apiOrigin: "https://api.pirate.test",
      delegatedAgentAccessToken: "delegated-token",
      agentId: "agt_1",
      commentId: "cmt_parent",
      body: "Nested reply",
      fetch: fetchMock as unknown as typeof fetch,
      signAgentActionProof: proofFor(proofRequests),
    })

    expect(result.comment.id).toBe("cmt_nested")
    expect(calls).toEqual(["reply"])
    expect(proofRequests[0]?.url).toBe("https://api.pirate.test/comments/cmt_parent/replies")
  })

  test("agentCreatePost blocks when delegated top-level posts are disallowed", async () => {
    const fetchMock = async () => toolResponse({
      capabilities: {
        community: "com_resolved",
        write: {
          delegated_agent_top_level_post: {
            allowed: false,
            blocked_reason: "agent_top_level_posts_disallowed",
            hint: "This community allows delegated-agent replies only.",
          },
        },
      },
    })

    await expect(agentCreatePost({
      apiOrigin: "https://api.pirate.test",
      delegatedAgentAccessToken: "delegated-token",
      agentId: "agt_1",
      community: "com_1",
      title: "Hello",
      body: "Body",
      fetch: fetchMock as unknown as typeof fetch,
      signAgentActionProof: proofFor([]),
    })).rejects.toMatchObject({
      name: "PirateConnectorError",
      code: "capability_blocked",
    } satisfies Partial<PirateConnectorError>)
  })

  test("delegated writes fail clearly when capabilities require ALTCHA but no proof was provided", async () => {
    const fetchMock = async () => toolResponse({
      capabilities: {
        community: "com_resolved",
        write: {
          delegated_agent_reply: {
            allowed: true,
            requires: ["altcha"],
            hint: "ALTCHA required.",
          },
        },
      },
    })

    await expect(agentReplyToThread({
      apiOrigin: "https://api.pirate.test",
      delegatedAgentAccessToken: "delegated-token",
      agentId: "agt_1",
      community: "com_1",
      postId: "post_1",
      body: "Reply",
      fetch: fetchMock as unknown as typeof fetch,
      signAgentActionProof: proofFor([]),
    })).rejects.toMatchObject({
      name: "PirateConnectorError",
      code: "pow_required",
      message: "ALTCHA required.",
    } satisfies Partial<PirateConnectorError>)
  })

  test("callMcpTool accepts options with access token and custom headers", async () => {
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer token")
      expect(headers.get("x-test")).toBe("yes")
      return toolResponse({ ok: true })
    }

    await expect(callMcpTool("https://api.pirate.test", "tool", {}, {
      fetch: fetchMock as unknown as typeof fetch,
      accessToken: "token",
      headers: {
        "x-test": "yes",
      },
    })).resolves.toEqual({ ok: true })
  })
})
