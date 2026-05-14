import { solveChallenge, type Challenge, type Payload } from "altcha-lib"
import { deriveKey } from "altcha-lib/algorithms/pbkdf2"

function readArg(name: string): string | null {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1] ?? null
}

function requiredArg(name: string): string {
  const value = readArg(name)?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function mcpCall(origin: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${origin.replace(/\/+$/, "")}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${text}`)
  }
  return text ? JSON.parse(text) : null
}

async function main(): Promise<void> {
  const origin = readArg("--origin") ?? "https://api-staging.pirate.sc"
  const communityId = requiredArg("--community")
  const postId = requiredArg("--post")
  const guestId = readArg("--guest") ?? `codex-smoke-${Date.now()}`

  const capabilities = await mcpCall(origin, {
    jsonrpc: "2.0",
    id: 0,
    method: "tools/call",
    params: {
      name: "get_pirate_board_capabilities",
      arguments: {
        community_id: communityId,
      },
    },
  }) as {
    result?: { structuredContent?: { capabilities?: { write?: { guest_comment?: { allowed?: boolean } } } } }
    error?: { message?: string }
  }
  if (capabilities.error) {
    throw new Error(`get_pirate_board_capabilities failed: ${capabilities.error.message ?? JSON.stringify(capabilities.error)}`)
  }
  const guestCommentAllowed = capabilities.result?.structuredContent?.capabilities?.write?.guest_comment?.allowed
  if (guestCommentAllowed !== true) {
    throw new Error(`guest comments are not allowed according to capabilities: ${JSON.stringify(capabilities)}`)
  }

  const prepare = await mcpCall(origin, {
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
  }) as {
    result?: { structuredContent?: { challenge?: Challenge; scope?: string; action?: string } }
    error?: { message?: string }
  }
  if (prepare.error) {
    throw new Error(`prepare_guest_comment failed: ${prepare.error.message ?? JSON.stringify(prepare.error)}`)
  }
  const challenge = prepare.result?.structuredContent?.challenge
  if (!challenge) {
    throw new Error(`prepare_guest_comment did not return a challenge: ${JSON.stringify(prepare)}`)
  }
  const solution = await solveChallenge({ challenge, deriveKey })
  if (!solution) {
    throw new Error("ALTCHA challenge did not solve")
  }
  const altcha = btoa(JSON.stringify({ challenge, solution } satisfies Payload))

  const reply = await mcpCall(origin, {
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
        body: `Live MCP ALTCHA smoke ${new Date().toISOString()}`,
        idempotency_key: `live-mcp-guest-smoke-${Date.now()}`,
        altcha,
      },
    },
  }) as {
    result?: { structuredContent?: { comment?: { id?: string } } }
    error?: { message?: string }
  }
  if (reply.error) {
    throw new Error(`reply failed: ${reply.error.message ?? JSON.stringify(reply.error)}`)
  }
  const commentId = reply.result?.structuredContent?.comment?.id
  if (!commentId) {
    throw new Error(`reply did not return a comment id: ${JSON.stringify(reply)}`)
  }

  const replay = await mcpCall(origin, {
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
        body: "Replay should fail",
        idempotency_key: `live-mcp-guest-smoke-replay-${Date.now()}`,
        altcha,
      },
    },
  }) as { error?: { message?: string } }
  if (!replay.error?.message?.includes("replayed")) {
    throw new Error(`replay was not rejected as replayed: ${JSON.stringify(replay)}`)
  }

  console.log(JSON.stringify({
    ok: true,
    origin,
    community: communityId,
    post: postId,
    guest_id: guestId,
    comment: commentId,
    guest_comment_allowed: guestCommentAllowed,
    prepare_action: prepare.result?.structuredContent?.action ?? null,
    replay_error: replay.error.message,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
