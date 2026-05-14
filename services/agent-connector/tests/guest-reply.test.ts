import { describe, expect, test } from "bun:test"
import { guestReplyToThread, PirateConnectorError } from "../src/index"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
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

function challengeResponse(): Record<string, unknown> {
  return {
    guest_id: "guest-1",
    challenge: {
      algorithm: "PBKDF2/SHA-256",
      cost: 1,
      keyLength: 32,
      keyPrefix: "abc",
      keySignature: "sig",
      nonce: "nonce",
      salt: "salt",
    },
    scope: "comment_create",
    action: "post:post_1",
  }
}

describe("guestReplyToThread", () => {
  test("composes capabilities, prepare, local PoW solve, and reply without surfacing challenge", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string; arguments: Record<string, unknown> }
      }
      calls.push(body.params)

      if (body.params.name === "get_pirate_board_capabilities") {
        return toolResponse({
          capabilities: {
            write: {
              guest_comment: {
                allowed: true,
                requires: ["altcha"],
              },
            },
          },
        })
      }
      if (body.params.name === "prepare_guest_comment") {
        return toolResponse(challengeResponse())
      }
      if (body.params.name === "reply") {
        expect(body.params.arguments.altcha).toBe("solved-pow")
        return toolResponse({
          comment: {
            id: "cmt_1",
            status: "published",
            authorship_mode: "guest",
            anonymous_label: "anon_test",
          },
        })
      }
      throw new Error(`unexpected tool ${body.params.name}`)
    }

    const result = await guestReplyToThread({
      apiOrigin: "https://api.pirate.test",
      community: "com_1",
      postId: "post_1",
      guestId: "guest-1",
      idempotencyKey: "idem-1",
      body: "hello",
      fetch: fetchMock as unknown as typeof fetch,
      solveAltcha: async () => "solved-pow",
    })

    expect(result.comment.id).toBe("cmt_1")
    expect(calls.map((call) => call.name)).toEqual([
      "get_pirate_board_capabilities",
      "prepare_guest_comment",
      "reply",
    ])
    expect(calls[2]?.arguments).toMatchObject({
      authorship_mode: "guest",
      guest_id: "guest-1",
      community_id: "com_1",
      post_id: "post_1",
      idempotency_key: "idem-1",
      altcha: "solved-pow",
    })
  })

  test("blocks before prepare when capabilities deny guest comments", async () => {
    const fetchMock = async () => toolResponse({
      capabilities: {
        write: {
          guest_comment: {
            allowed: false,
            blocked_reason: "guest_comments_disallowed",
            hint: "Use a delegated agent or user bearer token.",
          },
        },
      },
    })

    await expect(guestReplyToThread({
      apiOrigin: "https://api.pirate.test",
      community: "com_1",
      postId: "post_1",
      body: "hello",
      fetch: fetchMock as unknown as typeof fetch,
      solveAltcha: async () => "unused",
    })).rejects.toMatchObject({
      name: "PirateConnectorError",
      code: "capability_blocked",
    } satisfies Partial<PirateConnectorError>)
  })

  test("composes nested comment replies without a board capability preflight", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string; arguments: Record<string, unknown> }
      }
      calls.push(body.params)

      if (body.params.name === "prepare_guest_comment") {
        expect(body.params.arguments).toEqual({
          guest_id: "guest-1",
          comment_id: "cmt_parent",
        })
        return toolResponse(challengeResponse())
      }
      if (body.params.name === "reply") {
        expect(body.params.arguments).toMatchObject({
          authorship_mode: "guest",
          guest_id: "guest-1",
          comment_id: "cmt_parent",
          body: "nested hello",
          idempotency_key: "idem-nested",
          altcha: "solved-pow",
        })
        return toolResponse({
          comment: {
            id: "cmt_nested",
            status: "published",
            authorship_mode: "guest",
          },
        })
      }
      throw new Error(`unexpected tool ${body.params.name}`)
    }

    const result = await guestReplyToThread({
      apiOrigin: "https://api.pirate.test",
      commentId: "cmt_parent",
      guestId: "guest-1",
      idempotencyKey: "idem-nested",
      body: "nested hello",
      fetch: fetchMock as unknown as typeof fetch,
      solveAltcha: async () => "solved-pow",
    })

    expect(result.comment.id).toBe("cmt_nested")
    expect(calls.map((call) => call.name)).toEqual(["prepare_guest_comment", "reply"])
  })

  test("reports missing ALTCHA challenge before attempting reply", async () => {
    const calls: string[] = []
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: { name: string } }
      calls.push(body.params.name)
      if (body.params.name === "get_pirate_board_capabilities") {
        return toolResponse({
          capabilities: {
            write: {
              guest_comment: {
                allowed: true,
              },
            },
          },
        })
      }
      if (body.params.name === "prepare_guest_comment") {
        return toolResponse({
          scope: "comment_create",
          action: "post:post_1",
        })
      }
      throw new Error(`unexpected tool ${body.params.name}`)
    }

    await expect(guestReplyToThread({
      apiOrigin: "https://api.pirate.test",
      community: "com_1",
      postId: "post_1",
      body: "hello",
      fetch: fetchMock as unknown as typeof fetch,
      solveAltcha: async () => "unused",
    })).rejects.toMatchObject({
      name: "PirateConnectorError",
      code: "missing_altcha_challenge",
    } satisfies Partial<PirateConnectorError>)
    expect(calls).toEqual(["get_pirate_board_capabilities", "prepare_guest_comment"])
  })

  test("reports missing comment after reply", async () => {
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string; arguments: Record<string, unknown> }
      }
      if (body.params.name === "get_pirate_board_capabilities") {
        return toolResponse({
          capabilities: {
            write: {
              guest_comment: {
                allowed: true,
              },
            },
          },
        })
      }
      if (body.params.name === "prepare_guest_comment") {
        return toolResponse(challengeResponse())
      }
      if (body.params.name === "reply") {
        return toolResponse({
          comment: {
            status: "published",
          },
        })
      }
      throw new Error(`unexpected tool ${body.params.name}`)
    }

    await expect(guestReplyToThread({
      apiOrigin: "https://api.pirate.test",
      community: "com_1",
      postId: "post_1",
      body: "hello",
      fetch: fetchMock as unknown as typeof fetch,
      solveAltcha: async () => "solved-pow",
    })).rejects.toMatchObject({
      name: "PirateConnectorError",
      code: "missing_comment",
    } satisfies Partial<PirateConnectorError>)
  })

  test("propagates hosted MCP HTTP errors", async () => {
    const fetchMock = async () => new Response("bad gateway", { status: 502 })

    await expect(guestReplyToThread({
      apiOrigin: "https://api.pirate.test",
      community: "com_1",
      postId: "post_1",
      body: "hello",
      fetch: fetchMock as unknown as typeof fetch,
      solveAltcha: async () => "unused",
    })).rejects.toMatchObject({
      name: "PirateConnectorError",
      code: "mcp_http_error",
      details: "bad gateway",
    } satisfies Partial<PirateConnectorError>)
  })

  test("propagates hosted MCP JSON-RPC errors", async () => {
    const fetchMock = async () => jsonResponse({
      jsonrpc: "2.0",
      id: "test",
      error: {
        code: -32000,
        message: "Guest comments are not enabled",
        data: {
          details: {
            error: "guest_comments_disallowed",
          },
        },
      },
    })

    await expect(guestReplyToThread({
      apiOrigin: "https://api.pirate.test",
      community: "com_1",
      postId: "post_1",
      body: "hello",
      fetch: fetchMock as unknown as typeof fetch,
      solveAltcha: async () => "unused",
    })).rejects.toMatchObject({
      name: "PirateConnectorError",
      code: "mcp_protocol_error",
      message: "Guest comments are not enabled",
    } satisfies Partial<PirateConnectorError>)
  })
})
