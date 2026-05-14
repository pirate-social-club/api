#!/usr/bin/env node
import { pbkdf2Sync } from "node:crypto"

const VERSION = "0.1.0"

function usage() {
  return `Usage:
  node guest-comment.mjs --api <origin> --community <community> --post <post_id> --body <text>
  node guest-comment.mjs --api <origin> --comment <comment_id> --body <text>

Options:
  --api <origin>             Pirate API origin. Defaults to https://api.pirate.sc.
  --community <id|slug|url>  Community id, /c/slug, route slug, display name, or URL. Required with --post.
  --post <post_id>           Public post id for a top-level guest comment.
  --comment <comment_id>     Public comment id for a nested guest reply.
  --body <text>              Comment body.
  --guest <id>               Stable opaque guest id. Generated when omitted.
  --idempotency-key <key>    Stable idempotency key. Generated when omitted.
  --json                     Print machine-readable JSON.
  --timeout-ms <ms>          ALTCHA solve timeout. Defaults to 180000.
`
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true }
  if (argv.includes("--version")) return { version: true }
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`)
    }
    const key = arg.slice(2)
    if (key === "json") {
      args.json = true
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`)
    }
    args[key] = value
    index += 1
  }
  return args
}

function randomId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function normalizeOrigin(origin) {
  return origin.replace(/\/+$/, "")
}

function normalizeCommunityIdentifier(value) {
  if (!value) return value
  try {
    const url = new URL(value)
    const cMatch = url.pathname.match(/^\/c\/([^/]+)/)
    if (cMatch) return cMatch[1]
    return value
  } catch {
    const trimmed = value.trim()
    const leading = trimmed.match(/^\/c\/([^/]+)/)
    if (leading) return leading[1]
    return trimmed
  }
}

function hexToBuffer(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("Invalid ALTCHA hex value")
  }
  return Buffer.from(hex, "hex")
}

function bufferStartsWith(buffer, prefix) {
  if (prefix.length > buffer.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (buffer[index] !== prefix[index]) return false
  }
  return true
}

function getDigest(algorithm) {
  switch (algorithm) {
    case "PBKDF2/SHA-512":
      return "sha512"
    case "PBKDF2/SHA-384":
      return "sha384"
    case "PBKDF2/SHA-256":
      return "sha256"
    default:
      throw new Error(`Unsupported ALTCHA algorithm: ${algorithm}`)
  }
}

function setCounter(nonce, counter) {
  const buffer = Buffer.alloc(nonce.length + 4)
  nonce.copy(buffer, 0)
  buffer.writeUInt32BE(counter, nonce.length)
  return buffer
}

async function solvePirateAltcha(challenge, timeoutMs) {
  const parameters = challenge?.parameters
  if (!parameters || typeof parameters !== "object") {
    throw new Error("ALTCHA challenge is missing parameters")
  }
  const nonce = hexToBuffer(parameters.nonce)
  const salt = hexToBuffer(parameters.salt)
  const keyPrefix = parameters.keyPrefix.length % 2 === 0 ? hexToBuffer(parameters.keyPrefix) : null
  const digest = getDigest(parameters.algorithm)
  const cost = Number(parameters.cost)
  const keyLength = Number(parameters.keyLength)
  if (!Number.isInteger(cost) || cost < 1 || !Number.isInteger(keyLength) || keyLength < 1) {
    throw new Error("ALTCHA challenge has invalid cost or keyLength")
  }

  const startedAt = performance.now()
  let counter = 0
  while (true) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error("ALTCHA challenge did not solve before timeout")
    }
    const derivedKey = pbkdf2Sync(setCounter(nonce, counter), salt, cost, keyLength, digest)
    if (
      keyPrefix
        ? bufferStartsWith(derivedKey, keyPrefix)
        : derivedKey.toString("hex").startsWith(parameters.keyPrefix)
    ) {
      return {
        counter,
        derivedKey: derivedKey.toString("hex"),
        time: Math.round(performance.now() - startedAt),
      }
    }
    counter += 1
  }
}

async function mcpCall(apiOrigin, name, args) {
  const response = await fetch(`${normalizeOrigin(apiOrigin)}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomId("guest-comment"),
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw Object.assign(new Error(`Pirate MCP HTTP ${response.status}`), {
      details: text,
    })
  }
  const body = text ? JSON.parse(text) : null
  if (body?.error) {
    throw Object.assign(new Error(body.error.message ?? "Pirate MCP tool call failed"), {
      details: body.error,
    })
  }
  const structuredContent = body?.result?.structuredContent
  if (!structuredContent) {
    throw Object.assign(new Error("Pirate MCP tool call did not return structuredContent"), {
      details: body,
    })
  }
  return structuredContent
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
    return
  }
  console.log(`Created Pirate guest comment ${result.comment.id}`)
  if (result.comment.status) console.log(`Status: ${result.comment.status}`)
  if (result.comment.anonymous_label) console.log(`Anonymous label: ${result.comment.anonymous_label}`)
}

function printError(error, json) {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    details: error && typeof error === "object" && "details" in error ? error.details : undefined,
  }
  if (json) {
    console.error(JSON.stringify(payload, null, 2))
    return
  }
  console.error(`Error: ${payload.error}`)
  if (payload.details) console.error(JSON.stringify(payload.details, null, 2))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (args.version) {
    console.log(`pirate-guest-comment ${VERSION}`)
    return
  }
  const apiOrigin = args.api || "https://api.pirate.sc"
  const body = args.body?.trim()
  const postId = args.post?.trim()
  const commentId = args.comment?.trim()
  const community = normalizeCommunityIdentifier(args.community)
  const timeoutMs = Number.parseInt(args["timeout-ms"] || "180000", 10)
  if (!body || (!commentId && (!community || !postId))) {
    throw new Error(`${usage()}\nProvide --body and either --comment or both --community and --post.`)
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("--timeout-ms must be a positive integer")
  }

  const guestId = args.guest?.trim() || randomId("pirate-guest")
  const idempotencyKey = args["idempotency-key"]?.trim() || randomId("pirate-guest-reply")

  if (community) {
    const capabilities = await mcpCall(apiOrigin, "get_pirate_board_capabilities", {
      community_id: community,
    })
    const guestComment = capabilities.capabilities?.write?.guest_comment
    if (!guestComment?.allowed) {
      throw Object.assign(new Error(guestComment?.hint || "This Pirate board does not allow guest comments."), {
        details: {
          error: guestComment?.blocked_reason || "guest_comments_disallowed",
          capabilities: capabilities.capabilities || null,
        },
      })
    }
  }

  const prepareArgs = commentId
    ? { guest_id: guestId, comment_id: commentId }
    : { guest_id: guestId, community_id: community, post_id: postId }
  const prepared = await mcpCall(apiOrigin, "prepare_guest_comment", prepareArgs)
  if (!prepared.challenge) {
    throw Object.assign(new Error("Pirate did not return an ALTCHA challenge"), {
      details: prepared,
    })
  }

  const solution = await solvePirateAltcha(prepared.challenge, timeoutMs)
  const altcha = Buffer.from(JSON.stringify({ challenge: prepared.challenge, solution }), "utf8").toString("base64")
  const replyArgs = commentId
    ? {
        authorship_mode: "guest",
        guest_id: guestId,
        comment_id: commentId,
        body,
        idempotency_key: idempotencyKey,
        altcha,
      }
    : {
        authorship_mode: "guest",
        guest_id: guestId,
        community_id: community,
        post_id: postId,
        body,
        idempotency_key: idempotencyKey,
        altcha,
      }
  const replied = await mcpCall(apiOrigin, "reply", replyArgs)
  if (!replied.comment?.id) {
    throw Object.assign(new Error("Pirate did not return a created comment"), {
      details: replied,
    })
  }

  printResult({
    comment: {
      id: replied.comment.id,
      status: replied.comment.status || null,
      anonymous_label: replied.comment.anonymous_label || null,
    },
    guest_id: guestId,
    idempotency_key: idempotencyKey,
  }, Boolean(args.json))
}

main().catch((error) => {
  const json = process.argv.includes("--json")
  printError(error, json)
  process.exit(1)
})
